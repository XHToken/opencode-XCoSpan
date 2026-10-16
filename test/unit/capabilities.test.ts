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
      return { text: JSON.stringify({ reason: "Needs analysis", route: 1 }) }
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

test.each([
  { reason: "Available tools can compute and verify the result", route: 0 },
  { reason: "The user requests cloud collaboration", route: 1 },
])("model and service routing share the same numeric contract: %j", async (decision) => {
  const input = {
    query: "Current task",
    context: [{ role: "user", text: "Prior task" }],
    files: [],
    capabilities: { localModel: config.localModel, cloudModel: config.cloudModel, tools: [], skills: [] },
  }
  const generate = {
    async text(request: { prompt: string }) {
      expect(request.prompt).toContain(JSON.stringify(input))
      return { text: JSON.stringify(decision) }
    },
  } as Plugin.Context["generate"]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(await request.json()).toEqual(input)
      return Response.json(decision)
    },
  })
  try {
    const expected = { cloud: decision.route === 1, reason: decision.reason }
    expect(await capabilities(config, generate).route(input)).toEqual(expected)
    expect(await capabilities({ ...config, routeURL: String(server.url) }, generate).route(input)).toEqual(
      expected,
    )
  } finally {
    server.stop(true)
  }
})

test.each([
  { reason: "Invalid route", route: "1" },
  { reason: "Invalid route", route: true },
  { reason: "Invalid route", route: 2 },
  { reason: "Invalid route", route: 0.5 },
  { reason: "   ", route: 0 },
  { reason: "Unexpected property", route: 1, cloud: true },
  { reason: "Missing numeric route", cloud: true },
])("invalid algorithm decisions fail for model and service calls: %j", async (decision) => {
  const generate = {
    async text() {
      return { text: JSON.stringify(decision) }
    },
  } as Plugin.Context["generate"]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(decision),
  })
  const input = {
    query: "Task",
    context: [],
    files: [],
    capabilities: { localModel: config.localModel, cloudModel: config.cloudModel, tools: [], skills: [] },
  }
  try {
    await expect(capabilities(config, generate).route(input)).rejects.toThrow()
    await expect(
      capabilities({ ...config, routeURL: String(server.url) }, generate).route(input),
    ).rejects.toThrow()
  } finally {
    server.stop(true)
  }
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
