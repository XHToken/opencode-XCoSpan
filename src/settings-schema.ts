import { z } from "zod"
import { ModelRef } from "./types"
export const SettingsDocument = z.object({
  token: z.string(),
  path: z.string(),
  target: z.string(),
  revision: z.string(),
})
export const SettingsInput = z
  .object({
    token: z.string(),
    revision: z.string(),
    localModel: ModelRef,
    cloudModel: ModelRef,
    enabled: z.boolean(),
    defaultAgent: z.boolean().optional(),
  })
  .strict()
export const CustomProvider = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    modelID: z.string().trim().min(1),
    baseURL: z.url(),
    protocol: z.enum(["openai-compatible", "openai", "anthropic"]),
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  })
  .strict()
