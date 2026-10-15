import { expect, test } from "bun:test"
import { liveModels } from "../live/config"

const config = {
  localModel: { providerID: "device", id: "compact" },
  cloudModel: { providerID: "remote", id: "reasoner" },
  providers: {
    device: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "http://localhost:9000/v1/", apiKey: "{env:DEVICE_KEY}" },
      models: { compact: { limit: { context: 262144, output: 131072 }, body: { max_tokens: 131072 } } },
    },
    remote: {
      package: "@opencode/ai/providers/another-provider",
      settings: {
        baseURL: "https://model.example/api",
        apiKey: "{env:CLOUD_KEY}",
        headers: { "x-region": "test" },
      },
      models: {
        reasoner: { limit: { context: 1048576, output: 393216 }, body: { max_completion_tokens: 393216 } },
      },
    },
  },
  websearch: { provider: "configured-search" },
}

test("live model configuration preserves native settings and independent model contracts", () => {
  const models = liveModels(config)
  expect(models.local.baseURL).toBe("http://localhost:9000/v1")
  expect(models.cloud.baseURL).toBe("https://model.example/api")
  expect(models.local.expectedRequest).toEqual({ model: "compact", max_tokens: 131072 })
  expect(models.cloud.expectedRequest).toEqual({ model: "reasoner", max_completion_tokens: 393216 })
  expect(models.cloud.provider("http://localhost:1234/cloud")).toEqual({
    ...config.providers.remote,
    settings: { ...config.providers.remote.settings, baseURL: "http://localhost:1234/cloud" },
  })
})

test("live configuration reports missing models and malformed addresses", () => {
  expect(() => liveModels({ ...config, cloudModel: { providerID: "missing", id: "reasoner" } })).toThrow(
    "Missing live provider",
  )
  expect(() => liveModels({ ...config, localModel: { providerID: "device", id: "missing" } })).toThrow(
    "Missing live model",
  )
  for (const baseURL of [
    "file:///tmp/model",
    "https://user:secret@model.example",
    "https://model.example?key=secret",
  ]) {
    const invalid = structuredClone(config)
    invalid.providers.remote.settings.baseURL = baseURL
    expect(() => liveModels(invalid)).toThrow("Live provider baseURL")
  }
})
