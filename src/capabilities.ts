import { z } from "zod"
import { RouteResult, RedactionResult, type Config, type Content } from "./types"
import type { Plugin } from "@opencode/plugin"
import { ROUTE_INSTRUCTIONS, REDACT_INSTRUCTIONS } from "./prompts"

export type RouteInput = {
  query: string
  context: unknown
  files: unknown
  capabilities: {
    localModel: Config["localModel"]
    cloudModel: Config["cloudModel"]
    tools: { name: string; description: string }[]
    skills: { name: string; description?: string }[]
  }
}

export function capabilities(config: Config, generate: Plugin.Context["generate"]) {
  for (const address of [config.routeURL, config.redactURL]) {
    if (!address) continue
    const url = new URL(address)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("Routing and redaction services must run on loopback")
    }
    if (url.username || url.password) throw new Error("Use environment variables for capability credentials")
  }
  async function call<T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    keyEnv?: string,
    signal?: AbortSignal,
  ) {
    const key = keyEnv ? process.env[keyEnv] : undefined
    if (keyEnv && !key) throw new Error(`Missing environment variable: ${keyEnv}`)
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        ...(config.timeoutMs === undefined ? [] : [AbortSignal.timeout(config.timeoutMs)]),
        ...(signal ? [signal] : []),
      ]),
    })
    if (!response.ok) throw new Error(`Capability request failed: HTTP ${response.status}`)
    return schema.parse(await response.json())
  }
  async function generateText(instructions: string, input: unknown, signal?: AbortSignal) {
    const response = await generate.text(
      { model: config.localModel, prompt: `${instructions}\n\nInput data:\n${JSON.stringify(input)}` },
      {
        signal: AbortSignal.any([
          ...(config.timeoutMs === undefined ? [] : [AbortSignal.timeout(config.timeoutMs)]),
          ...(signal ? [signal] : []),
        ]),
      },
    )
    return response.text
  }
  return {
    route: (input: RouteInput, signal?: AbortSignal) =>
      config.routeURL
        ? call(config.routeURL, input, RouteResult, config.routeKeyEnv, signal)
        : generateText(
            `${ROUTE_INSTRUCTIONS}\nOutput JSON Schema:${JSON.stringify(z.toJSONSchema(RouteResult))}`,
            input,
            signal,
          ).then((text) => RouteResult.parse(JSON.parse(text))),
    redact: async (content: Content, signal?: AbortSignal) => {
      if (config.redactURL)
        return call(config.redactURL, { content }, RedactionResult, config.redactKeyEnv, signal)
      if (content.type === "image")
        throw new Error(
          "Image redaction requires an image-capable local redaction service; configure redactURL",
        )
      const text = await generateText(REDACT_INSTRUCTIONS, { text: content.text }, signal)
      return RedactionResult.parse({
        content: { type: "text", text },
        changes: "Review the redacted candidate against the original; edit it before approval if needed.",
      })
    },
  }
}
