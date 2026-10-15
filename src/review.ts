import { randomUUID } from "node:crypto"
import { ActionError } from "./errors"
import type { Plugin } from "@opencode/plugin"
import { Review, parseCandidate } from "./types"

type Store = Plugin.Context["storage"]
type Notify = (sessionID: string, id: string) => Promise<void>

export class Reviews {
  private pending = new Map<string, { resolve(value: Review): void; reject(error: Error): void }>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private store: Store,
    private notify: Notify,
  ) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async list(sessionID?: string): Promise<Review[]> {
    const records: Review[] = []
    let after: string | undefined
    do {
      const page = await this.store.scan({ prefix: "review/", limit: 100, after })
      for (const item of page.entries) {
        const review = Review.parse(item.value)
        if (sessionID === undefined || review.sessionID === sessionID) records.push(review)
      }
      after = page.next
    } while (after)
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async restore(ownsSession: (sessionID: string) => Promise<boolean>) {
    for (const review of await this.list()) {
      if (review.status !== "pending" || !(await ownsSession(review.sessionID))) continue
      review.status = "interrupted"
      await this.store.set(`review/${review.id}`, review)
    }
  }

  async get(id: string, sessionID: string): Promise<Review> {
    const record = await this.store.get(`review/${id}`)
    if (!record) throw new ActionError("Review not found")
    const review = Review.parse(record)
    if (review.sessionID !== sessionID) throw new ActionError("Review belongs to another session")
    return review
  }

  async request(
    input: Pick<Review, "sessionID" | "callID" | "kind" | "original" | "candidate" | "note">,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    const review = Review.parse({
      ...input,
      id: randomUUID(),
      revision: 1,
      status: "pending",
      createdAt: new Date().toISOString(),
    })
    parseCandidate(review, review.candidate)
    await this.store.set(`review/${review.id}`, review)
    const waiting = this.wait(review, signal)
    // Attach rejection handling before notifying clients: cancellation may arrive during emit.
    const settled = waiting.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    try {
      await this.notify(review.sessionID, review.id)
    } catch (error) {
      await this.cancel(review.id, review.sessionID)
      throw error
    }
    const result = await settled
    if ("error" in result) throw result.error
    signal.throwIfAborted()
    return result.value
  }

  private wait(review: Review, signal: AbortSignal): Promise<Review> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        void this.cancel(review.id, review.sessionID).catch(reject)
      }
      this.pending.set(review.id, {
        resolve: (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
      })
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  edit(id: string, sessionID: string, revision: number, candidate: unknown) {
    return this.serial(async () => {
      const record = await this.get(id, sessionID)
      this.assertPending(record, revision)
      record.candidate = parseCandidate(record, candidate)
      record.revision++
      await this.store.set(`review/${id}`, record)
      await this.notify(sessionID, id)
      return record
    })
  }

  approve(id: string, sessionID: string, revision: number) {
    return this.serial(async () => {
      const record = await this.get(id, sessionID)
      this.assertPending(record, revision)
      if (!this.pending.has(id))
        throw new ActionError(
          "The original tool is no longer waiting; retry the tool to review a new candidate",
        )
      record.status = "approved"
      await this.store.set(`review/${id}`, record)
      const waiter = this.pending.get(id)
      this.pending.delete(id)
      waiter?.resolve(record)
      await this.notify(sessionID, id)
      return record
    })
  }

  cancel(id: string, sessionID: string) {
    return this.serial(async () => {
      const record = await this.get(id, sessionID)
      if (record.status === "approved") throw new ActionError("This review is already approved")
      if (record.status === "cancelled") return record
      record.status = "cancelled"
      await this.store.set(`review/${id}`, record)
      const waiter = this.pending.get(id)
      this.pending.delete(id)
      waiter?.reject(new Error("Review cancelled; no outbound task was started"))
      await this.notify(sessionID, id)
      return record
    })
  }

  private assertPending(record: Review, revision: number) {
    if (record.status !== "pending") throw new ActionError(`Review is ${record.status}`)
    if (record.revision !== revision) throw new ActionError("Review changed; reload the latest revision")
  }

  async close() {
    const ids = [...this.pending.keys()]
    for (const id of ids) {
      const raw = await this.store.get(`review/${id}`)
      const record = Review.parse(raw)
      await this.cancel(id, record.sessionID)
    }
  }
}
