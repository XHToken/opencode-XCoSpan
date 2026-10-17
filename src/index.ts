import { Agent, Model, Plugin, Provider, Skill } from "@opencode/plugin"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { capabilities } from "./capabilities"
import { registerContext } from "./context"
import { CLOUD_AGENT, CLOUD_TOOLS, Delegations, PRIMARY_AGENT } from "./delegate"
import { PRIMARY_INSTRUCTIONS, CLOUD_INSTRUCTIONS } from "./prompts"
import { Reviews } from "./review"
import { ActionError, exposeAction, isMissingSession } from "./errors"
import { XCoSpan } from "./rpc"
import { Config, Content, Task, RouteResult } from "./types"
import { withRouting } from "./routing"
import { currentRedactionID, registerRedaction } from "./redact"
import { withCloudNetwork } from "./network"
import { management } from "./management"

const DelegateInput = z
  .object({
    reviewIds: z
      .array(z.string())
      .min(1)
      .describe(
        "IDs returned by approved redact or redact_image calls for the current query. Their reviewed contents are attached automatically. Every delegation requires an approved review.",
      ),
  })
  .strict()

const plugin = {
  id: "xcospan",
  async setup(ctx: Plugin.Context, lifecycle: import("./routing").Lifecycle) {
    const configured = Object.keys(ctx.options).length > 0
    const config = configured ? Config.parse(ctx.options) : undefined
    const lifetime = new AbortController()
    let emit = async (_sessionID: string, _id: string) => {}
    const reviews = new Reviews(ctx.storage, (sessionID, id) => emit(sessionID, id))
    const ownsSession = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      return session.location.directory === ctx.location.directory
    }
    const runs = new Delegations(ctx, reviews, (sessionID, id) => emit(sessionID, id))
    lifecycle.deleted = async (sessionID) => {
      await runs.remove(sessionID)
      await reviews.remove(sessionID)
    }
    const records = [...(await reviews.list()), ...(await runs.list())]
    for (const sessionID of new Set(records.map((record) => record.sessionID))) {
      try {
        await ctx.session.get({ sessionID })
      } catch (error) {
        if (!isMissingSession(error, sessionID)) throw error
        await lifecycle.deleted(sessionID)
      }
    }
    await reviews.restore(ownsSession)
    await runs.restore(ownsSession)
    const executing = async (sessionID: string, callID: string) =>
      (await ctx.session.context({ sessionID })).some(
        (message) =>
          message.type === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "tool" &&
              part.id === callID &&
              (part.state.status === "running" || part.state.status === "streaming"),
          ),
      )
    const manage = await management(ctx, config, lifecycle)
    const rpc = await ctx.rpc.register(XCoSpan, {
      ...manage,
      status: async () => ({
        ready: !!config && config.enabled !== false,
        message: config
          ? config.enabled === false
            ? "XCoSpan is disabled; enable it through /xcospan"
            : "XCoSpan is configured"
          : "Configure local and cloud models through /xcospan.",
      }),
      list: async ({ sessionID }) => ({
        reviews: await reviews.list(sessionID),
        runs: await runs.list(sessionID),
      }),
      get: ({ id, sessionID }, rpc) => exposeAction(() => reviews.get(id, sessionID), rpc),
      edit: ({ id, sessionID, revision, candidate }, rpc) =>
        exposeAction(() => reviews.edit(id, sessionID, revision, candidate), rpc),
      approve: ({ id, sessionID, revision }, rpc) =>
        exposeAction(() => reviews.approve(id, sessionID, revision), rpc),
      cancel: ({ id, sessionID }, rpc) =>
        exposeAction(async () => {
          const review = await reviews.get(id, sessionID)
          const active = review.status === "pending" && (await executing(sessionID, review.callID))
          const cancelled = await reviews.cancel(id, sessionID)
          if (active) await lifecycle.stop(sessionID)
          return cancelled
        }, rpc),
      cancelRun: ({ id, sessionID }, rpc) =>
        exposeAction(async () => {
          if (!config) throw new ActionError("Configure local and cloud models first")
          const run = await runs.get(id, sessionID)
          const active = await executing(sessionID, run.callID)
          const cancelled = await runs.cancel(id, sessionID)
          if (active && cancelled.status === "cancelled") await lifecycle.stop(sessionID)
          return cancelled
        }, rpc),
      recover: ({ id, sessionID }, rpc) =>
        exposeAction(async () => {
          if (!config) throw new ActionError("Configure local and cloud models first")
          return runs.recover(id, sessionID)
        }, rpc),
    })
    emit = async (sessionID, id) => rpc.events.emit("changed", { sessionID, id })
    if (!config) return () => rpc.dispose()
    const service = capabilities(config, ctx.generate)
    const model = (ref: Config["localModel"]) => ({
      id: Model.ID.make(ref.id),
      providerID: Provider.ID.make(ref.providerID),
    })
    await ctx.agent.transform((editor) => {
      editor.update(Agent.ID.make(PRIMARY_AGENT), (agent) => {
        agent.name = Agent.Name.make(PRIMARY_AGENT)
        agent.description = "Local coordinator with on-demand cloud collaboration"
        agent.mode = "primary"
        agent.model = model(config.localModel)
        agent.system = PRIMARY_INSTRUCTIONS
        agent.permissions.push(
          ...["subagent", "websearch", "webfetch"].map((action) => ({
            action,
            resource: "*",
            effect: "deny" as const,
          })),
        )
      })
      editor.update(Agent.ID.make(CLOUD_AGENT), (agent) => {
        agent.mode = "subagent"
        agent.hidden = true
        agent.model = model(config.cloudModel)
        agent.system = CLOUD_INSTRUCTIONS
        agent.permissions = [
          { action: "*", resource: "*", effect: "deny" },
          ...CLOUD_TOOLS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
        ]
      })
    })
    const skillPath = fileURLToPath(new URL("../skills/materials/SKILL.md", import.meta.url))
    const skillContent = await Bun.file(skillPath).text()
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillContent)
    if (!frontmatter) throw new Error("Bundled material Skill has no frontmatter")
    const skill = z
      .object({ name: z.string().min(1), description: z.string().min(1) })
      .parse(Bun.YAML.parse(frontmatter[1]!))
    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(skill.name),
        name: Skill.Name.make(skill.name),
        description: skill.description,
        path: skillPath as Skill.Info["path"],
        content: skillContent,
      })
    })
    await registerContext(ctx, config, runs, reviews)
    await registerRedaction(ctx, service.redact, reviews, lifetime.signal, !!config.redactURL)
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "cloud_delegate",
        options: { codemode: false },
        input: DelegateInput,
        description:
          "Execute cloud collaboration from approved reviewIds. Pass only the IDs of reviewed materials for the current query, with the task handoff first. The plugin loads their exact contents, obtains final outbound approval, and returns the actual execution result.",
        async execute(input, tool) {
          if (tool.agent !== PRIMARY_AGENT)
            throw new Error("Cloud delegation is available to the xcospan agent")
          const history = await ctx.session.context({ sessionID: tool.sessionID })
          const user = history.findLast((message) => message.type === "user")
          const session = await ctx.session.get({ sessionID: tool.sessionID })
          const route = session.metadata?.xcospanRoute
          if (
            !route ||
            typeof route !== "object" ||
            !("messageID" in route) ||
            route.messageID !== user?.id ||
            !RouteResult.parse(route.result).cloud
          )
            throw new Error("The current query was not routed to cloud collaboration")
          const reviewID = currentRedactionID(history)
          if (!reviewID || !input.reviewIds.includes(reviewID))
            throw new Error("Complete redaction review and include its approved reviewId before delegation")
          const materials: Content[] = []
          for (const id of input.reviewIds) {
            const review = await reviews.get(id, tool.sessionID)
            if (review.kind !== "redaction" || review.status !== "approved")
              throw new Error("Material has not been approved")
            materials.push(Content.parse(review.candidate))
          }
          const handoff = materials.findIndex((item) => item.type === "text")
          const instructions = materials[handoff]
          if (instructions?.type !== "text")
            throw new Error("Include a reviewed text handoff describing the task before delegation")
          return runs.execute(
            Task.parse({
              instructions: instructions.text,
              materials: materials.filter((_, index) => index !== handoff),
            }),
            { ...tool, signal: AbortSignal.any([tool.signal, lifetime.signal]) },
            config.cloudModel,
          )
        },
      })
    })
    return async () => {
      lifetime.abort()
      await reviews.close()
      await rpc.dispose()
    }
  },
}

export default withCloudNetwork(withRouting(plugin))
