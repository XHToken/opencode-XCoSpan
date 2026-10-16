import { randomUUID } from "node:crypto"
import { Agent, type Plugin } from "@opencode/plugin"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
import { z } from "zod"
import { XCoSpan } from "./rpc"
import { ActionError, exposeAction } from "./errors"
import { Settings } from "./settings"
import { Config, ModelRef } from "./types"
import type { Lifecycle } from "./routing"
import { PRIMARY_AGENT, CLOUD_AGENT } from "./delegate"
import { sessionFailure } from "./status"

type Methods = Pick<
  RpcHandlers<typeof XCoSpan>,
  "settings" | "saveSettings" | "addProvider" | "removePlugin" | "stop" | "enter" | "leave" | "testModel"
>
const Previous = z.object({ agent: z.string(), model: ModelRef.extend({ variant: z.string().optional() }) })
const PROBE = "xcospan-model-check"
export async function management(
  ctx: Plugin.Context,
  config: Config | undefined,
  lifecycle: Lifecycle,
): Promise<Methods> {
  const settings = new Settings(ctx)
  const generation = randomUUID()
  const checkReady = () => {
    if (!config) throw new ActionError("Configure both models through /xcospan first")
    if (config.enabled === false || lifecycle.stopping)
      throw new ActionError("XCoSpan is disabled or stopping")
    return config
  }
  const idle = () => {
    if (lifecycle.stopping) throw new ActionError("Settings are being applied; wait for completion")
    if (lifecycle.sessions.size)
      throw new ActionError("Active tasks exist; stop them before changing configuration")
  }
  await ctx.tool.hook("execute.before", (event) => {
    if ([PRIMARY_AGENT, CLOUD_AGENT].includes(event.agent)) checkReady()
  })
  await ctx.agent.transform((editor) =>
    editor.update(Agent.ID.make(PROBE), (agent) => {
      agent.mode = "subagent"
      agent.hidden = true
      agent.permissions = [
        { action: "*", resource: "*", effect: "deny" },
        { action: "xcospan_model_probe", resource: "*", effect: "allow" },
      ]
    }),
  )
  await ctx.session.hook("context", (event) => {
    if (event.agent === PROBE) {
      for (const name of Object.keys(event.tools))
        if (name !== "xcospan_model_probe") delete event.tools[name]
    } else delete event.tools.xcospan_model_probe
  })
  await ctx.tool.transform((editor) =>
    editor.add({
      name: "xcospan_model_probe",
      options: { codemode: false },
      description: "Synthetic model compatibility test. Returns the supplied value.",
      input: z.object({ value: z.string() }).strict(),
      async execute(input, tool) {
        if (tool.agent !== PROBE) throw new Error("Compatibility probe is restricted to the test agent")
        return { content: input.value }
      },
    }),
  )
  return {
    settings: (input, rpc) =>
      exposeAction(
        async () => ({
          documents: input.paths.length ? await settings.inspect(input.paths) : [],
          ...(config ? { localModel: config.localModel, cloudModel: config.cloudModel } : {}),
          enabled: config?.enabled !== false,
          active: lifecycle.sessions.size,
          generation,
        }),
        rpc,
      ),
    saveSettings: (input, rpc) =>
      exposeAction(async () => {
        idle()
        lifecycle.stopping = true
        try {
          const changed = await settings.save(input)
          if (!changed) lifecycle.stopping = false
          return { changed }
        } catch (error) {
          lifecycle.stopping = false
          throw error
        }
      }, rpc),
    addProvider: (input, rpc) =>
      exposeAction(async () => {
        idle()
        await settings.provider(input.token, input.revision, input.provider)
        return {}
      }, rpc),
    removePlugin: (input, rpc) =>
      exposeAction(async () => {
        idle()
        lifecycle.stopping = true
        try {
          await settings.remove(input.token, input.revision)
        } catch (error) {
          lifecycle.stopping = false
          throw error
        }
        return {}
      }, rpc),
    stop: (input, rpc) =>
      exposeAction(async () => {
        if (lifecycle.stopping) throw new ActionError("Settings are being applied; wait for completion")
        if (!input.sessionID) lifecycle.stopping = true
        try {
          if (input.sessionID) {
            const session = await ctx.session.get({ sessionID: input.sessionID })
            if (session.location.directory !== ctx.location.directory || session.agent !== PRIMARY_AGENT)
              throw new ActionError("This session is not using XCoSpan")
          }
          await lifecycle.stop(input.sessionID)
        } finally {
          if (!input.sessionID) lifecycle.stopping = false
        }
        return {}
      }, rpc),
    enter: (input, rpc) =>
      exposeAction(async () => {
        const current = checkReady()
        await settings.validateModels(current)
        if (!input.sessionID) {
          const session = await ctx.session.create({ agent: PRIMARY_AGENT, model: current.localModel })
          return { sessionID: session.id }
        }
        const session = await ctx.session.get({ sessionID: input.sessionID })
        if (session.location.directory !== ctx.location.directory)
          throw new ActionError("The session does not belong to this project")
        if (lifecycle.sessions.has(session.id))
          throw new ActionError("Wait for the current task to finish before switching agents")
        if (session.agent !== PRIMARY_AGENT) {
          if (!session.agent || !session.model) throw new ActionError("Select an agent and model first")
          await ctx.session.update({
            sessionID: session.id,
            metadata: {
              ...session.metadata,
              xcospanPrevious: { agent: session.agent, model: session.model },
            },
          })
        }
        await ctx.session.switchAgent({ sessionID: session.id, agent: PRIMARY_AGENT })
        await ctx.session.switchModel({ sessionID: session.id, model: current.localModel })
        return { sessionID: session.id }
      }, rpc),
    leave: (input, rpc) =>
      exposeAction(async () => {
        const session = await ctx.session.get(input)
        if (session.location.directory !== ctx.location.directory)
          throw new ActionError("The session does not belong to this project")
        if (session.agent !== PRIMARY_AGENT) throw new ActionError("The current session is not using XCoSpan")
        if (lifecycle.sessions.has(session.id)) throw new ActionError("Stop the current task first")
        const previous = Previous.safeParse(session.metadata?.xcospanPrevious)
        if (!previous.success)
          throw new ActionError("This session started with xcospan; choose an agent through /agents")
        await ctx.session.switchAgent({ sessionID: session.id, agent: previous.data.agent })
        await ctx.session.switchModel({ sessionID: session.id, model: previous.data.model })
        return {}
      }, rpc),
    testModel: (ref, rpc) =>
      exposeAction(async () => {
        await settings.validateModels({ localModel: ref, cloudModel: ref })
        const nonce = randomUUID()
        const session = await ctx.session.create({
          title: "XCoSpan · Model connection check",
          agent: PROBE,
          model: ref,
        })
        lifecycle.sessions.add(session.id)
        const cancel = () => {
          void ctx.session.interrupt({ sessionID: session.id, resume: false })
        }
        rpc.signal.addEventListener("abort", cancel, { once: true })
        try {
          rpc.signal.throwIfAborted()
          await ctx.session.prompt({
            sessionID: session.id,
            text:
              "Call xcospan_model_probe with value " +
              nonce +
              ". After receiving the tool result, reply with that value. This is synthetic compatibility data.",
          })
          await ctx.session.wait({ sessionID: session.id })
          const history = await ctx.session.context({ sessionID: session.id })
          const sessionInfo = await ctx.session.get({ sessionID: session.id })
          if (sessionInfo.outcome !== "succeeded")
            throw new ActionError(sessionFailure(history) || "Model check incomplete")
          const called = history.some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "tool" &&
                  part.name === "xcospan_model_probe" &&
                  part.state.status === "completed",
              ),
          )
          if (!called) throw new ActionError("Connection succeeded; tool calling did not complete")
          return { text: "Connection and tool calling passed" }
        } finally {
          rpc.signal.removeEventListener("abort", cancel)
          await ctx.session.interrupt({ sessionID: session.id, resume: false })
          lifecycle.sessions.delete(session.id)
        }
      }, rpc),
  }
}
