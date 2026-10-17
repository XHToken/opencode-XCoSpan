import type { Plugin } from "@opencode/plugin/effect"
import type { Effect } from "effect"

type History = Effect.Success<ReturnType<Plugin.Context["session"]["context"]>>
export type RoutingMessage = { role: "user" | "assistant"; text: string; truncated: boolean }

const RECENT_TURNS = 3
const TEXT_CHARACTERS = 600

export function routingHistory(history: History): RoutingMessage[] {
  const turns: RoutingMessage[][] = []
  function excerpt(role: RoutingMessage["role"], text: string): RoutingMessage {
    const characters = Array.from(text)
    return {
      role,
      text: characters.slice(0, TEXT_CHARACTERS).join(""),
      truncated: characters.length > TEXT_CHARACTERS,
    }
  }
  for (const message of history) {
    if (message.type === "user") {
      turns.push([excerpt("user", message.text)])
      if (turns.length > RECENT_TURNS) turns.shift()
    } else if (message.type === "assistant") {
      const turn = turns.at(-1)
      if (!turn) continue
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (text.trim()) turn[1] = excerpt("assistant", text)
    }
  }
  return turns.flat()
}
