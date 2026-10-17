import type { Plugin } from "@opencode/plugin/effect"
import type { Effect } from "effect"

type History = Effect.Success<ReturnType<Plugin.Context["session"]["context"]>>
export type RoutingMessage = { role: "user" | "assistant"; text: string; truncated: boolean }

const RECENT_TURNS = 3
const TEXT_CHARACTERS = 500
const HISTORY_CHARACTERS = 1000

export function routingHistory(history: History): RoutingMessage[] {
  const turns: RoutingMessage[][] = []
  for (const message of history) {
    if (message.type === "user") {
      turns.push([{ role: "user", text: message.text, truncated: false }])
      if (turns.length > RECENT_TURNS) turns.shift()
    } else if (message.type === "assistant") {
      const turn = turns.at(-1)
      if (!turn) continue
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (text.trim()) turn[1] = { role: "assistant", text, truncated: false }
    }
  }
  let remaining = HISTORY_CHARACTERS
  const selected: RoutingMessage[][] = []
  for (const turn of turns.reverse()) {
    const entries: RoutingMessage[] = []
    for (const entry of turn) {
      if (!remaining) break
      const characters = Array.from(entry.text)
      const text = characters.slice(0, Math.min(TEXT_CHARACTERS, remaining))
      entries.push({ ...entry, text: text.join(""), truncated: text.length < characters.length })
      remaining -= text.length
    }
    if (entries.length) selected.unshift(entries)
    if (!remaining) break
  }
  return selected.flat()
}
