import { expect, test } from "bun:test"
import { capabilities } from "../../src/capabilities"
import { Config } from "../../src/types"
import type { Plugin } from "@opencode/plugin"

const config = Config.parse({
  localModel: { providerID: "local", id: "configured-model" },
  cloudModel: { providerID: "cloud", id: "configured-model" },
})

test("model capabilities preserve configured model and caller cancellation without default limits", async () => {
  const controller = new AbortController()
  let observed: AbortSignal | undefined
  const generate = {
    async text(input: unknown, options?: { signal?: AbortSignal }) {
      expect(Object.keys(input as object).sort()).toEqual(["model", "prompt"])
      expect((input as { model: unknown }).model).toEqual(config.localModel)
      observed = options?.signal
      return { text: JSON.stringify({ cloud: true, reason: "Needs analysis" }) }
    },
  } as Plugin.Context["generate"]
  expect(config.timeoutMs).toBeUndefined()
  const result = await capabilities(config, generate).route(
    {
      query: "Task",
      context: [],
      files: [],
      capabilities: { localModel: config.localModel, cloudModel: config.cloudModel, tools: [], skills: [] },
    },
    controller.signal,
  )
  expect(result.cloud).toBe(true)
  controller.abort()
  expect(observed?.aborted).toBe(true)
})

test("malformed model output fails without replacing the route", async () => {
  const generate = {
    async text() {
      return { text: "not JSON" }
    },
  } as Plugin.Context["generate"]
  await expect(
    capabilities(config, generate).route({
      query: "Task",
      context: [],
      files: [],
      capabilities: { localModel: config.localModel, cloudModel: config.cloudModel, tools: [], skills: [] },
    }),
  ).rejects.toThrow()
})

test("remote redaction capability URLs are rejected before sending private content", () => {
  const generate = {} as Plugin.Context["generate"]
  expect(() => capabilities({ ...config, redactURL: "https://example.com/redact" }, generate)).toThrow(
    "loopback",
  )
})

test("text redaction preserves the model's complete candidate without JSON wrapping", async () => {
  const candidate = "Buyer: [Customer A]\nPayment split: 30% / 70%\nPreserve the {number} in each clause."
  const generate = {
    async text() {
      return { text: candidate }
    },
  } as Plugin.Context["generate"]
  const result = await capabilities(config, generate).redact({ type: "text", text: "Private source" })
  expect(result.content).toEqual({ type: "text", text: candidate })
})
