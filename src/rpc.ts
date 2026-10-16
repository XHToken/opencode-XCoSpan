import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { Review, Run, ModelRef } from "./types"
import { SettingsDocument, SettingsInput, CustomProvider } from "./settings-schema"

const errors = { action: z.object({}).strict() }
const SessionInput = z.object({ sessionID: z.string() }).strict()
const ReviewInput = z.object({ id: z.string(), sessionID: z.string() }).strict()
export const XCoSpan = Rpc.define({
  id: "xcospan",
  methods: {
    settings: {
      input: z.object({ paths: z.array(z.string()) }).strict(),
      errors,
      output: z.object({
        documents: z.array(SettingsDocument),
        localModel: ModelRef.optional(),
        cloudModel: ModelRef.optional(),
        enabled: z.boolean(),
        active: z.number(),
        generation: z.string(),
      }),
    },
    saveSettings: { input: SettingsInput, errors, output: z.object({ changed: z.boolean() }) },
    addProvider: {
      input: z.object({ token: z.string(), revision: z.string(), provider: CustomProvider }).strict(),
      errors,
      output: z.object({}),
    },
    removePlugin: {
      input: z.object({ token: z.string(), revision: z.string() }).strict(),
      errors,
      output: z.object({}),
    },
    stop: { input: z.object({ sessionID: z.string().optional() }).strict(), errors, output: z.object({}) },
    enter: {
      input: z.object({ sessionID: z.string().optional() }).strict(),
      errors,
      output: z.object({ sessionID: z.string() }),
    },
    leave: { input: SessionInput, errors, output: z.object({}) },
    testModel: { input: ModelRef, errors, output: z.object({ text: z.string() }) },
    status: { input: z.object({}).strict(), output: z.object({ ready: z.boolean(), message: z.string() }) },
    list: { input: SessionInput, output: z.object({ reviews: z.array(Review), runs: z.array(Run) }) },
    get: { input: ReviewInput, errors, output: Review },
    edit: {
      input: ReviewInput.extend({ revision: z.number().int(), candidate: z.unknown() }),
      errors,
      output: Review,
    },
    approve: { input: ReviewInput.extend({ revision: z.number().int() }), errors, output: Review },
    cancel: { input: ReviewInput, errors, output: Review },
    cancelRun: { input: ReviewInput, errors, output: Run },
    recover: { input: ReviewInput, errors, output: Run },
  },
  events: { changed: { schema: z.object({ sessionID: z.string(), id: z.string() }) } },
})
