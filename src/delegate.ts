import { randomUUID } from "node:crypto"
import { ActionError, isMissingSession } from "./errors"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Run, Task, imageURI, type Config } from "./types"
import type { Reviews } from "./review"
import { sessionFailure } from "./status"

export const CLOUD_AGENT = "xcospan-cloud-worker"
export const PRIMARY_AGENT = "xcospan"
export const CLOUD_TOOLS = ["websearch", "webfetch"]

export function taskPrompt(task: Task): string {
  return [task.instructions, ...task.materials.flatMap((item) => (item.type === "text" ? [item.text] : []))]
    .filter(Boolean)
    .join("\n\n")
}

export class Delegations {
  private active = new Map<string, { cancel: AbortController; done: Promise<void> }>()
  constructor(
    private ctx: Plugin.Context,
    private reviews: Reviews,
    private changed: (sessionID: string, id: string) => Promise<void>,
  ) {}

  async list(sessionID?: string) {
    const records: Run[] = []
    let after: string | undefined
    do {
      const page = await this.ctx.storage.scan({ prefix: "run/", after, limit: 100 })
      records.push(
        ...page.entries
          .map((item) => Run.parse(item.value))
          .filter((run) => sessionID === undefined || run.sessionID === sessionID),
      )
      after = page.next
    } while (after)
    return records
  }

  async restore(ownsSession: (sessionID: string) => Promise<boolean>) {
    for (const run of await this.list()) {
      if (run.delivered || !["completed", "prepared", "running", "cancelling"].includes(run.status)) continue
      if (!(await ownsSession(run.sessionID))) continue
      // Admit completed results before the host resumes orphaned parent turns.
      if (run.status === "completed") {
        await this.recover(run.id, run.sessionID, true)
        continue
      }
      run.status = "unknown"
      run.error = "Connection lost. Use /xcospan-recover to check the cloud task and retrieve its result."
      await this.save(run)
    }
  }

  async remove(sessionID: string) {
    for (const run of await this.list(sessionID)) {
      // Native session deletion waits for its execution to stop before emitting the event.
      await this.active.get(run.id)?.done
      await this.ctx.storage.remove(`child/${run.childID}`)
      await this.ctx.storage.remove(`run/${run.id}`)
    }
  }

  async get(id: string, sessionID: string) {
    const raw = await this.ctx.storage.get(`run/${id}`)
    if (!raw) throw new ActionError("Cloud task not found")
    const run = Run.parse(raw)
    if (run.sessionID !== sessionID) throw new Error("Run belongs to another session")
    return run
  }

  async child(sessionID: string): Promise<Run | undefined> {
    const id = await this.ctx.storage.get(`child/${sessionID}`)
    if (typeof id !== "string") return undefined
    return Run.parse(await this.ctx.storage.get(`run/${id}`))
  }

  async save(run: Run) {
    await this.ctx.storage.set(`run/${run.id}`, run)
    await this.changed(run.sessionID, run.id)
  }

  async execute(task: Task, context: ToolContext, cloudModel: Config["cloudModel"]) {
    await context.progress({ status: "awaiting_confirmation" })
    const approved = await this.reviews.request(
      {
        sessionID: context.sessionID,
        callID: context.id,
        kind: "outbound",
        original: task,
        candidate: task,
        note: `Cloud model: ${cloudModel.providerID}/${cloudModel.id}; tools: ${CLOUD_TOOLS.join(", ")}. Review the complete text and all images before approving cloud collaboration.`,
      },
      context.signal,
    )
    context.signal.throwIfAborted()
    await context.progress({ status: "preparing" })
    const candidate = Task.parse(approved.candidate)
    const run: Run = {
      id: randomUUID(),
      sessionID: context.sessionID,
      callID: context.id,
      reviewID: approved.id,
      childID: `ses_${randomUUID().replaceAll("-", "")}`,
      promptID: `msg_${randomUUID().replaceAll("-", "")}`,
      status: "prepared",
      delivered: false,
    }
    const cancel = new AbortController()
    const signal = AbortSignal.any([context.signal, cancel.signal])
    const done = Promise.withResolvers<void>()
    this.active.set(run.id, { cancel, done: done.promise })
    let created = false
    let interrupt: Promise<unknown> | undefined
    let interruptionError: unknown
    const abort = () => {
      if (created)
        interrupt = this.ctx.session.interrupt({ sessionID: run.childID, resume: false }).catch((error) => {
          interruptionError = error
        })
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      // Persist both identities before admitting work; recovery never launches a replacement.
      await this.save(run)
      await this.ctx.storage.set(`child/${run.childID}`, run.id)
      signal.throwIfAborted()
      await this.ctx.session.create({
        id: run.childID,
        parentID: run.sessionID,
        title: "Cloud collaboration",
        agent: CLOUD_AGENT,
        model: cloudModel,
        metadata: { xcospanRun: run.id },
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...CLOUD_TOOLS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
        ],
      })
      created = true
      signal.throwIfAborted()
      await context.progress({ sessionID: run.childID, status: "running" })
      run.status = "running"
      await this.save(run)
      await this.ctx.session.prompt({
        sessionID: run.childID,
        id: run.promptID,
        text: taskPrompt(candidate),
        files: candidate.materials.flatMap((item) =>
          item.type === "image" ? [{ uri: imageURI(item) }] : [],
        ),
      })
      if (signal.aborted) abort()
      await this.ctx.session.wait({ sessionID: run.childID })
      signal.throwIfAborted()
      const settled = await this.settle(run)
      if (settled.status !== "completed")
        throw new Error(
          `Cloud task ${settled.status}${settled.error ? `: ${settled.error}` : ""}; run ${run.id}`,
        )
      // The native tool result is the normal delivery; recovery verifies the host record before injecting anything.
      return {
        content: settled.result!,
        metadata: { sessionID: run.childID, runID: run.id, status: settled.status },
      }
    } catch (error) {
      const stored = await this.get(run.id, run.sessionID)
      if (!["completed", "cancelled", "failed"].includes(stored.status)) {
        stored.status = signal.aborted
          ? "cancelling"
          : isMissingSession(error, run.childID)
            ? "failed"
            : "unknown"
        stored.error = error instanceof Error ? error.message : "Cloud task failed"
        await this.save(stored)
      }
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
      try {
        if (signal.aborted) {
          if (created) {
            // Creation or prompt admission may finish after the first cancellation request.
            await interrupt
            abort()
            await interrupt
            if (interruptionError) throw interruptionError
            await this.ctx.session.wait({ sessionID: run.childID })
          }
          const stopped = await this.get(run.id, run.sessionID)
          stopped.status = "cancelled"
          await this.save(stopped)
        }
      } finally {
        this.active.delete(run.id)
        done.resolve()
      }
    }
  }

  async settle(run: Run) {
    let child
    try {
      child = await this.ctx.session.get({ sessionID: run.childID })
    } catch (error) {
      if (!isMissingSession(error, run.childID)) throw error
      run.status = "failed"
      run.error = "The collaboration session was deleted; its result cannot be recovered"
      await this.save(run)
      return run
    }
    if (child.parentID !== run.sessionID || child.metadata?.xcospanRun !== run.id)
      throw new Error("Child session ownership changed")
    run.status =
      child.outcome === "succeeded"
        ? "completed"
        : child.outcome === "failed"
          ? "failed"
          : child.outcome === "interrupted"
            ? "cancelled"
            : "unknown"
    if (run.status === "failed") {
      const history = await this.ctx.session.context({ sessionID: run.childID })
      run.error = sessionFailure(history)
    }
    if (run.status === "completed") {
      const history = await this.ctx.session.context({ sessionID: run.childID })
      const last = history.findLast((message) => message.type === "assistant")
      const text =
        last?.type === "assistant"
          ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          : ""
      if (!text) throw new Error("Cloud run succeeded without a textual deliverable")
      run.result = text
    }
    await this.save(run)
    return run
  }

  async cancel(id: string, sessionID: string) {
    const run = await this.get(id, sessionID)
    if (["completed", "failed", "cancelled"].includes(run.status)) return run
    const active = this.active.get(id)
    if (active) {
      active.cancel.abort(new Error("User cancelled cloud run"))
      await active.done
      return this.get(id, sessionID)
    }
    run.status = "cancelling"
    await this.save(run)
    try {
      await this.ctx.session.interrupt({ sessionID: run.childID, resume: false })
      await this.ctx.session.wait({ sessionID: run.childID })
    } catch (error) {
      if (!isMissingSession(error, run.childID)) throw error
    }
    return this.settle(run)
  }

  async recover(id: string, sessionID: string, restoring = false) {
    const run = await this.get(id, sessionID)
    const parent = await this.ctx.session.context({ sessionID })
    const original = parent
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .find((part) => part.type === "tool" && part.id === run.callID)
    if (original?.type === "tool" && original.state.status === "completed") {
      run.delivered = true
      await this.save(run)
      return run
    }
    if (original?.type === "tool" && original.state.status === "running" && !restoring)
      throw new ActionError("Cloud collaboration is running. Wait for completion or use /xcospan-cancel.")
    try {
      await this.ctx.session.wait({ sessionID: run.childID })
    } catch (error) {
      if (!isMissingSession(error, run.childID)) throw error
    }
    await this.settle(run)
    if (run.status !== "completed" || run.delivered) return run
    await this.ctx.session.synthetic({
      sessionID,
      id: `msg_xcospan_recovery_${run.id.replaceAll("-", "")}`,
      text: `Recovered cloud result (run ${run.id}, original call ${run.callID}):\n${run.result}`,
      metadata: { xcospanRecovery: run.id },
      resume: false,
    })
    run.delivered = true
    await this.save(run)
    return run
  }
}
