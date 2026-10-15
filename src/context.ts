import type { Plugin } from "@opencode/plugin"
import type { Media } from "@opencode/ai"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Delegations } from "./delegate"
import { CLOUD_AGENT, CLOUD_TOOLS, PRIMARY_AGENT, taskPrompt } from "./delegate"
import { CLOUD_INSTRUCTIONS } from "./prompts"
import { Task, imageURI, type Config } from "./types"
import type { Reviews } from "./review"

export async function registerContext(
  ctx: Plugin.Context,
  config: Config,
  runs: Delegations,
  reviews: Reviews,
) {
  async function prepareContext(event: SessionContext, compaction: boolean) {
    const run = await runs.child(event.sessionID)
    if (!run) {
      if (event.agent === CLOUD_AGENT)
        throw new Error("Cloud worker must be started through an approved delegation")
      if (
        event.agent === PRIMARY_AGENT &&
        (event.model.id !== config.localModel.id || event.model.providerID !== config.localModel.providerID)
      )
        throw new Error(
          `XCoSpan agent requires ${config.localModel.providerID}/${config.localModel.id}; got ${event.model.providerID}/${event.model.id}`,
        )
      return
    }
    const review = await reviews.get(run.reviewID, run.sessionID)
    if (review.status !== "approved" || !["running", "prepared"].includes(run.status))
      throw new Error("Cloud request has no active approval")
    if (event.model.id !== config.cloudModel.id || event.model.providerID !== config.cloudModel.providerID)
      throw new Error("Cloud model changed after approval")
    const history = await ctx.session.context({ sessionID: event.sessionID })
    const allowed = new Set(
      history
        .filter(
          (message) =>
            message.type === "assistant" || message.type === "compaction" || message.id === run.promptID,
        )
        .map((message) => message.id),
    )
    event.system = [
      {
        type: "text",
        text: compaction
          ? "Summarize the approved task, its progress, evidence and remaining work."
          : CLOUD_INSTRUCTIONS,
      },
    ]
    // Preserve native assistant/tool protocol data; omit workspace baselines and unrelated injected messages.
    event.messages = event.messages.filter(
      (message) =>
        message.role === "tool" ||
        (message.role !== "system" && message.id !== undefined && allowed.has(message.id)),
    )
    // Prompt attachments are normalized by the host; model input must use the approved bytes.
    const candidate = Task.parse(review.candidate)
    event.messages = event.messages.map((message) => {
      if (message.role !== "user" || message.id !== run.promptID) return message
      const images = candidate.materials.filter((item) => item.type === "image")
      const nativeImages = message.content.filter((part) => part.type === "media")
      if (nativeImages.length !== images.length)
        throw new Error("Cloud image attachments changed after approval")
      return {
        ...message,
        content: [
          { type: "text" as const, text: taskPrompt(candidate) },
          ...images.map((item, index) => {
            // The host validates Asset identity; use its public constructor across the plugin runtime boundary.
            const Asset = nativeImages[index]!.media.constructor as typeof Media.Asset
            return {
              type: "media" as const,
              media: new Asset({ source: { type: "base64", data: item.data, mediaType: item.mime } }),
            }
          }),
        ],
      }
    })
    event.tools = Object.fromEntries(
      Object.entries(event.tools).filter(([name]) => CLOUD_TOOLS.includes(name)),
    )
  }
  await ctx.session.hook("context", (event) => prepareContext(event, false))
  await ctx.session.hook("compaction", (event) => prepareContext(event, true))
  await ctx.session.hook("title", async (event) => {
    const session = await ctx.session.get({ sessionID: event.sessionID })
    if (session.agent === PRIMARY_AGENT || (await runs.child(event.sessionID))) event.result = "XCoSpan"
  })
  await ctx.session.hook("generate", async (event) => {
    if (await runs.child(event.sessionID))
      throw new Error("Transient generation is outside the approved cloud run")
  })
  await ctx.session.hook("prompt", async (event) => {
    const run = await runs.child(event.sessionID)
    if (!run) return
    const review = await reviews.get(run.reviewID, run.sessionID)
    const candidate = Task.parse(review.candidate)
    if (
      review.status !== "approved" ||
      event.messageID !== run.promptID ||
      event.prompt.text !== taskPrompt(candidate)
    )
      throw new Error("Cloud prompt differs from the approved task")
    if (event.prompt.skills?.length || event.prompt.agents?.length)
      throw new Error("Unapproved cloud attachments")
    const files = candidate.materials.flatMap((item) =>
      item.type === "image" ? [{ uri: imageURI(item) }] : [],
    )
    if (JSON.stringify(event.prompt.files ?? []) !== JSON.stringify(files))
      throw new Error("Cloud files differ from the approved task")
  })
}
