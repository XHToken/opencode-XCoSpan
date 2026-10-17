import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { capabilities } from "./capabilities"
import { PRIMARY_AGENT } from "./delegate"
import type { Reviews } from "./review"
import { Content, Image, imageURI } from "./types"

export function currentRedactionID(history: Awaited<ReturnType<Plugin.Context["session"]["context"]>>) {
  const currentQuery = history.findLastIndex((message) => message.type === "user")
  const part = history
    .slice(currentQuery + 1)
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast((part) => part.type === "tool" && ["redact", "redact_image"].includes(part.name))
  if (part?.type !== "tool" || part.state.status !== "completed") return
  const id = part.state.metadata?.reviewId
  return typeof id === "string" ? id : undefined
}

export async function registerRedaction(
  ctx: Plugin.Context,
  redact: ReturnType<typeof capabilities>["redact"],
  reviews: Reviews,
  lifetime: AbortSignal,
  imageEnabled: boolean,
) {
  async function review(content: Content, tool: ToolContext) {
    if (tool.agent !== PRIMARY_AGENT) throw new Error("Redaction is available to the xcospan agent")
    const signal = AbortSignal.any([tool.signal, lifetime])
    await tool.progress({ status: "redacting" })
    const result = await redact(content, signal)
    if (result.content.type !== content.type) throw new Error("Redaction service changed the material type")
    if (result.content.type === "image") imageURI(result.content)
    await tool.progress({ status: "awaiting_review" })
    const reviewed = await reviews.request(
      {
        sessionID: tool.sessionID,
        callID: tool.id,
        kind: "redaction",
        original: content,
        candidate: result.content,
        note: result.changes,
      },
      signal,
    )
    const approved = Content.parse(reviewed.candidate)
    return {
      content:
        approved.type === "text"
          ? JSON.stringify({ reviewId: reviewed.id, revision: reviewed.revision, text: approved.text })
          : [
              {
                type: "text" as const,
                text: JSON.stringify({ reviewId: reviewed.id, revision: reviewed.revision }),
              },
              { type: "file" as const, uri: imageURI(approved), mime: approved.mime },
            ],
      metadata: { reviewId: reviewed.id, status: "approved" },
    }
  }
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "redact",
      options: { codemode: false },
      input: z
        .object({
          content: z
            .string()
            .min(1)
            .describe(
              "Original text to redact, including relevant context or extracted document/table text.",
            ),
        })
        .strict(),
      description:
        "Submit selected original text to local redaction and user review. The tool identifies sensitive information, prepares the candidate and waits for user edits and approval. Returns the approved text and its reviewId for cloud_delegate.",
      execute: (input, tool) => review({ type: "text", text: input.content }, tool),
    })
    if (!imageEnabled) return
    editor.add({
      name: "redact_image",
      options: { codemode: false },
      input: z.object({ path: z.string().min(1).describe("Absolute path to the local image.") }).strict(),
      description:
        "Use the configured local image redaction service, then wait for user review. Returns approved image bytes and its reviewId for cloud_delegate.",
      async execute(input, tool) {
        if (tool.agent !== PRIMARY_AGENT) throw new Error("Redaction is available to the xcospan agent")
        const signal = AbortSignal.any([tool.signal, lifetime])
        const read = (await ctx.tool.list()).find((item) => item.id === "read")
        if (!read) throw new Error("Native read tool is unavailable")
        const result = await read.execute({ path: input.path }, { ...tool, signal })
        const file = Array.isArray(result.content)
          ? result.content.find((part) => part.type === "file")
          : undefined
        if (!file || file.type !== "file") throw new Error("The selected file is not an image")
        const prefix = `data:${file.mime};base64,`
        if (!file.uri.startsWith(prefix)) throw new Error("Native read did not return inline image bytes")
        const content = Image.parse({ type: "image", mime: file.mime, data: file.uri.slice(prefix.length) })
        imageURI(content)
        return review(content, tool)
      },
    })
  })
}
