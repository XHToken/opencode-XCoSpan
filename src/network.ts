import { Readable } from "node:stream"
import got from "got"
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from "request-filtering-agent"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { Plugin } from "@opencode/plugin/effect"
import { CLOUD_AGENT } from "./delegate"

export function publicWebTransport() {
  const agent = { http: new RequestFilteringHttpAgent(), https: new RequestFilteringHttpsAgent() }
  const fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request = new Request(input, init)
    if (request.method !== "GET") throw new Error("Cloud webfetch supports GET requests")
    const stream = got.stream(request.url, {
      agent,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      retry: { limit: 0 },
      throwHttpErrors: false,
    })
    return new Promise((resolve, reject) => {
      stream.once("error", reject)
      stream.once("response", (response) => {
        const headers = new Headers()
        for (const [name, values] of Object.entries(response.headers)) {
          if (values === undefined) continue
          for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value)
        }
        headers.delete("content-encoding")
        headers.delete("content-length")
        const empty = [204, 205, 304].includes(response.statusCode)
        if (empty) stream.resume()
        resolve(
          new Response(empty ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>), {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers,
          }),
        )
      })
    })
  }
  return {
    fetch,
    close() {
      agent.http.destroy()
      agent.https.destroy()
    },
  }
}

export function withCloudNetwork(plugin: Plugin.Plugin) {
  return Plugin.define({
    id: plugin.id,
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* plugin.effect(ctx)
        const transport = yield* Effect.acquireRelease(Effect.sync(publicWebTransport), (transport) =>
          Effect.sync(() => transport.close()),
        )
        yield* ctx.tool.transform((editor) => {
          const tool = editor.list().find((tool) => tool.name === "webfetch")
          if (!tool) throw new Error("OpenCode webfetch tool is required")
          editor.update(tool.id, (tool) => {
            const execute = tool.execute
            tool.execute = (input, context) => {
              const result = execute(input, context)
              // Keep the native tool's permissions, parsing, limits and cancellation.
              return context.agent === CLOUD_AGENT
                ? result.pipe(
                    Effect.provideService(FetchHttpClient.Fetch, transport.fetch as typeof globalThis.fetch),
                  )
                : result
            }
          })
        })
      }),
  })
}
