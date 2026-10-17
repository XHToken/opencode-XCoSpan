import { Effect, Schema, Stream } from "effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/plugin"
import { Plugin } from "@opencode/plugin/effect"
import type { Plugin as PromisePlugin } from "@opencode/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { capabilities } from "./capabilities"
import { PRIMARY_AGENT } from "./delegate"
import { Config, RouteResult } from "./types"
import { routingHistory } from "./routing-history"

export interface Lifecycle {
  sessions: Set<string>
  stopping: boolean
  deleted?(sessionID: string): Promise<void>
  stop(sessionID?: string): Promise<void>
}
export function withRouting(plugin: {
  id: string
  setup(ctx: PromisePlugin.Context, lifecycle: Lifecycle): ReturnType<PromisePlugin.Plugin["setup"]>
}) {
  return Plugin.define({
    id: plugin.id,
    effect: (ctx) =>
      Effect.gen(function* () {
        const runtime = yield* Effect.context()
        const sessions = new Set<SessionContext["sessionID"]>()
        const lifecycle: Lifecycle = {
          sessions,
          stopping: false,
          async stop(sessionID) {
            const targets = sessionID ? [sessionID] : [...sessions]
            for (const id of targets) {
              await Effect.runPromiseWith(runtime)(
                ctx.session.interrupt({ sessionID: id as SessionContext["sessionID"], resume: false }),
              )
              await Effect.runPromiseWith(runtime)(
                ctx.session.wait({ sessionID: id as SessionContext["sessionID"] }),
              )
            }
          },
        }
        yield* ctx.event.subscribe().pipe(
          Stream.runForEach((event) =>
            Effect.tryPromise(async () => {
              if (
                event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed" ||
                event.type === "session.execution.interrupted" ||
                event.type === "session.deleted" ||
                event.type === "session.moved"
              )
                sessions.delete(event.data.sessionID)
              if (event.type === "session.deleted") await lifecycle.deleted?.(event.data.sessionID)
            }).pipe(Effect.tapCause(Effect.logError), Effect.orDie),
          ),
          Effect.forkScoped,
        )
        const lifetime = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()))
        // OpenCode 2.0.27 drops call options in its Promise adapter; native Effect requests retain cancellation.
        const generate: PromisePlugin.Context["generate"] = {
          text: (input, options) =>
            Effect.runPromiseWith(runtime)(
              ctx.generate.text({
                prompt: input.prompt,
                model: input.model == null ? undefined : Schema.decodeUnknownSync(Model.Ref)(input.model),
              }),
              { signal: AbortSignal.any([lifetime.signal, ...(options?.signal ? [options.signal] : [])]) },
            ),
        }
        if (Object.keys(ctx.options).length) {
          const config = Config.parse(ctx.options)
          const service = capabilities(config, generate)
          yield* ctx.session.hook("context", (event) =>
            Effect.gen(function* () {
              if (event.agent !== PRIMARY_AGENT) {
                sessions.delete(event.sessionID)
                return
              }
              if (config.enabled === false || lifecycle.stopping)
                throw new Error("XCoSpan is disabled or stopping; manage it through /xcospan")
              sessions.add(event.sessionID)
              const history = yield* ctx.session.context({ sessionID: event.sessionID })
              const user = history.findLast((message) => message.type === "user")
              if (!user) return
              const session = yield* ctx.session.get({ sessionID: event.sessionID })
              const previous = session.metadata?.xcospanRoute
              let route
              if (
                previous &&
                typeof previous === "object" &&
                "messageID" in previous &&
                previous.messageID === user.id &&
                "result" in previous
              ) {
                route = RouteResult.parse(previous.result)
              } else {
                yield* ctx.session.update({
                  sessionID: event.sessionID,
                  metadata: { ...session.metadata, xcospanRoute: { messageID: user.id, status: "running" } },
                })
                const skills = yield* ctx.skill.list()
                route = yield* Effect.tryPromise({
                  try: (signal) =>
                    service.route(
                      {
                        query: user.text,
                        context: routingHistory(history.slice(0, history.indexOf(user))),
                        files: user.files ?? [],
                        capabilities: {
                          localModel: config.localModel,
                          cloudModel: config.cloudModel,
                          tools: Object.entries(event.tools)
                            .filter(([name]) => name !== "cloud_delegate")
                            .map(([name, tool]) => ({ name, description: tool.description })),
                          skills: skills.data.map(({ name, description }) => ({ name, description })),
                        },
                      },
                      AbortSignal.any([signal, lifetime.signal]),
                    ),
                  catch: (error) => error,
                })
                if (route.cloud) {
                  const { providerID, id } = config.cloudModel
                  const models = yield* ctx.model.list()
                  if (!models.data.some((model) => model.providerID === providerID && model.id === id))
                    throw new Error(
                      `Cloud model ${providerID}/${id} is unavailable. Check OpenCode providers and plugin cloudModel, then submit the task again.`,
                    )
                }
                const latest = yield* ctx.session.get({ sessionID: event.sessionID })
                yield* ctx.session.update({
                  sessionID: event.sessionID,
                  metadata: { ...latest.metadata, xcospanRoute: { messageID: user.id, result: route } },
                })
              }
              event.system.push({ type: "text", text: `Route: cloud=${route.cloud}. ${route.reason}` })
            }).pipe(Effect.orDie),
          )
        }
        yield* fromPromise({
          ...plugin,
          setup: (context) => plugin.setup({ ...context, generate }, lifecycle),
        }).effect(ctx)
        // Stop parent loops before plugin cleanup releases their waiting tools.
        yield* Effect.addFinalizer(() =>
          Effect.forEach([...sessions], (sessionID) => ctx.session.interrupt({ sessionID, resume: false }), {
            discard: true,
          }).pipe(Effect.orDie),
        )
      }),
  })
}
