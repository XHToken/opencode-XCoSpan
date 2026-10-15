import { z } from "zod"
import { ActionError } from "./errors"

const requiredText = (label: string) =>
  z.string().refine((text) => text.trim().length > 0, `${label} must not be empty`)

export const Text = z.object({ type: z.literal("text"), text: requiredText("Redacted content") }).strict()
export const Image = z
  .object({
    type: z.literal("image"),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z.string().min(1).describe("Base64 image bytes; never a mutable source path"),
  })
  .strict()
export const Content = z.discriminatedUnion("type", [Text, Image])
export type Content = z.infer<typeof Content>
export const Task = z
  .object({
    goal: requiredText("Task goal"),
    context: z.string(),
    expectedOutput: requiredText("Expected output"),
    materials: z.array(Content),
  })
  .strict()
export type Task = z.infer<typeof Task>
export const Review = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    callID: z.string(),
    kind: z.enum(["redaction", "outbound"]),
    revision: z.number().int().positive(),
    status: z.enum(["pending", "approved", "cancelled", "interrupted"]),
    original: z.union([Content, Task]),
    candidate: z.union([Content, Task]),
    note: z.string(),
    createdAt: z.string(),
  })
  .strict()
export type Review = z.infer<typeof Review>
export const Run = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    callID: z.string(),
    reviewID: z.string(),
    childID: z.string(),
    promptID: z.string(),
    status: z.enum(["prepared", "running", "completed", "failed", "cancelling", "cancelled", "unknown"]),
    result: z.string().optional(),
    error: z.string().optional(),
    delivered: z.boolean(),
  })
  .strict()
export type Run = z.infer<typeof Run>
export const ModelRef = z.object({ providerID: z.string().min(1), id: z.string().min(1) }).strict()
export const Config = z
  .object({
    localModel: ModelRef,
    cloudModel: ModelRef,
    enabled: z.boolean().optional(),
    previousDefaultAgent: z.string().nullable().optional(),
    routeURL: z.url().optional(),
    redactURL: z.url().optional(),
    routeKeyEnv: z.string().optional(),
    redactKeyEnv: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
export type Config = z.infer<typeof Config>

export const RouteResult = z.object({ cloud: z.boolean(), reason: z.string().min(1) }).strict()
export const RedactionResult = z.object({ content: Content, changes: z.string() }).strict()

export function parseCandidate(review: Review, candidate: unknown): Content | Task {
  const parsed = (review.kind === "outbound" ? Task : Content).safeParse(candidate)
  if (!parsed.success) throw new ActionError(parsed.error.issues.map((issue) => issue.message).join("; "))
  return parsed.data
}

export function imageURI(content: z.infer<typeof Image>): string {
  const bytes = Buffer.from(content.data, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== content.data) throw new Error("Invalid image base64")
  const valid =
    content.mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : content.mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
  if (!valid) throw new Error("Image bytes do not match MIME type")
  return `data:${content.mime};base64,${content.data}`
}
