import { z } from "zod"
import { ModelRef } from "../../src/types"

const Provider = z
  .object({
    package: z.string().min(1),
    settings: z.object({ baseURL: z.url() }).passthrough(),
    models: z.record(
      z.string(),
      z
        .object({
          body: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

export const LiveConfig = z
  .object({
    localModel: ModelRef,
    cloudModel: ModelRef,
    providers: z.record(z.string(), Provider),
    websearch: z.record(z.string(), z.unknown()),
  })
  .strict()

export function liveModels(input: unknown) {
  const config = LiveConfig.parse(input)
  function role(name: "local" | "cloud") {
    const ref = config[name === "local" ? "localModel" : "cloudModel"]
    const provider = config.providers[ref.providerID]
    if (!provider) throw new Error("Missing live provider: " + ref.providerID)
    const model = provider.models[ref.id]
    if (!model) throw new Error("Missing live model: " + ref.providerID + "/" + ref.id)
    const url = new URL(provider.settings.baseURL)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error(
        "Live provider baseURL must be an HTTP(S) base address without credentials, query or fragment",
      )
    const expectedRequest: Record<string, unknown> = { model: ref.id, ...model.body }
    return {
      id: ref.id,
      baseURL: provider.settings.baseURL.replace(/\/$/, ""),
      expectedRequest,
      provider: (proxyURL: string) => ({
        ...provider,
        settings: { ...provider.settings, baseURL: proxyURL },
        models: { [ref.id]: model },
      }),
    }
  }
  return { local: role("local"), cloud: role("cloud"), websearch: config.websearch }
}
