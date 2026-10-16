import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { Reviews } from "../../src/review"
import type { Review } from "../../src/types"

function fixture() {
  const data = new Map<string, unknown>()
  const store = {
    get: async (key: string) => structuredClone(data.get(key)),
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value))
    },
    remove: async (key: string) => {
      data.delete(key)
    },
    scan: async ({ prefix }: { prefix?: string }) => ({
      entries: [...data]
        .filter(([key]) => key.startsWith(prefix ?? ""))
        .map(([key, value]) => ({ key, value: structuredClone(value) })),
    }),
  } as Plugin.Context["storage"]
  const emitted = Promise.withResolvers<string>()
  const reviews = new Reviews(store, async (_session, id) => {
    emitted.resolve(id)
  })
  const input = {
    sessionID: "parent",
    callID: "call",
    kind: "redaction" as const,
    original: { type: "text" as const, text: "private" },
    candidate: { type: "text" as const, text: "redacted" },
    note: "test",
  }
  return { store, reviews, input, emitted: emitted.promise }
}

test("edits are revision-bound and approval is session-bound and single-use", async () => {
  const { reviews, input, emitted } = fixture()
  const waiting = reviews.request(input, new AbortController().signal)
  const id = await emitted
  await expect(reviews.approve(id, "other", 1)).rejects.toThrow("another session")
  await reviews.edit(id, "parent", 1, { type: "text", text: "edited" })
  await expect(reviews.approve(id, "parent", 1)).rejects.toThrow("reload")
  await reviews.approve(id, "parent", 2)
  expect((await waiting).candidate).toEqual({ type: "text", text: "edited" })
  await expect(reviews.approve(id, "parent", 2)).rejects.toThrow("approved")
})

test("abort persists cancellation and rejects the waiting tool", async () => {
  const { reviews, input, emitted } = fixture()
  const controller = new AbortController()
  const waiting = reviews.request(input, controller.signal).catch((error) => error)
  const id = await emitted
  controller.abort()
  expect(await waiting).toBeInstanceOf(Error)
  expect((await reviews.get(id, "parent")).status).toBe("cancelled")
})

test("persisted review cannot approve an orphaned tool after restart", async () => {
  const { store, input } = fixture()
  await store.set("review/orphan", {
    ...input,
    id: "orphan",
    revision: 1,
    status: "pending",
    createdAt: new Date().toISOString(),
  } satisfies Review)
  const restarted = new Reviews(store, async () => {})
  await expect(restarted.approve("orphan", "parent", 1)).rejects.toThrow("no longer waiting")
})

test("notification failure cancels the pending review", async () => {
  const { store, input } = fixture()
  let calls = 0
  const reviews = new Reviews(store, async () => {
    if (++calls === 1) throw new Error("disconnected")
  })
  await expect(reviews.request(input, new AbortController().signal)).rejects.toThrow("disconnected")
  expect((await reviews.list("parent"))[0]?.status).toBe("cancelled")
})

test("deleting a session removes its sensitive reviews and releases waiting tools", async () => {
  const { reviews, input, emitted, store } = fixture()
  const waiting = reviews.request(input, new AbortController().signal).catch((error) => error)
  const id = await emitted
  await store.set("review/other", { ...(await reviews.get(id, "parent")), id: "other", sessionID: "other" })
  await reviews.remove("parent")
  expect((await waiting).message).toBe("Session deleted")
  expect(await reviews.list("parent")).toEqual([])
  expect(await reviews.list("other")).toHaveLength(1)
  await expect(reviews.approve(id, "parent", 1)).rejects.toThrow("Review not found")
  await reviews.remove("parent")
  await reviews.close()
})
