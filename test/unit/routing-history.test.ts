import { expect, test } from "bun:test"
import { routingHistory } from "../../src/routing-history"

type History = Parameters<typeof routingHistory>[0]
const user = (text: string) => ({ type: "user", text })
const assistant = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] })
const project = (messages: unknown[]) => routingHistory(messages as History)

test("routing history retains the three most recent user turns in order", () => {
  const messages = Array.from({ length: 5 }, (_, index) => [
    user(`Task ${index}`),
    assistant(`Result ${index}`),
  ])
  expect(project(messages.flat())).toEqual(
    [2, 3, 4].flatMap((index) => [
      { role: "user", text: `Task ${index}`, truncated: false },
      { role: "assistant", text: `Result ${index}`, truncated: false },
    ]),
  )
})

test("routing history keeps the last assistant text and excludes execution payloads", () => {
  const messages = [
    assistant("Orphaned summary"),
    user("Continue the report"),
    assistant("Preparing"),
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "Private reasoning" },
        { type: "tool", name: "read", state: { output: "Entire document" } },
        { type: "text", text: "Report saved" },
        { type: "text", text: "One issue remains" },
      ],
    },
    { type: "assistant", content: [{ type: "tool", name: "write" }] },
    user("Handle that issue"),
  ]
  const before = JSON.stringify(messages)
  expect(project(messages)).toEqual([
    { role: "user", text: "Continue the report", truncated: false },
    { role: "assistant", text: "Report saved\nOne issue remains", truncated: false },
    { role: "user", text: "Handle that issue", truncated: false },
  ])
  expect(JSON.stringify(messages)).toBe(before)
})

test("routing excerpts are bounded and explicitly marked without splitting Unicode characters", () => {
  const text = "🙂".repeat(601)
  const messages = Array.from({ length: 4 }, () => [user(text), assistant(text)]).flat()
  const result = project(messages)
  expect(result).toHaveLength(6)
  expect(result.every((entry) => entry.truncated && entry.text === "🙂".repeat(600))).toBe(true)
  expect(result.reduce((length, entry) => length + Array.from(entry.text).length, 0)).toBe(3600)
  expect(project([user("a".repeat(600))])[0]?.truncated).toBe(false)
})

test("routing history permits empty history and unfinished prior turns", () => {
  expect(project([])).toEqual([])
  expect(project([user("Previous request")])).toEqual([
    { role: "user", text: "Previous request", truncated: false },
  ])
})
