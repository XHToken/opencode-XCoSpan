import { expect, test } from "bun:test"
import { ActionError, exposeAction, isMissingSession } from "../../src/errors"

test("RPC exposes declared action failures and preserves unexpected defects", async () => {
  const context = {
    error: (type: "action", message: string, data: Record<string, never>) => ({ type, message, data }),
  }
  await expect(
    exposeAction(async () => {
      throw new ActionError("Load the latest revision")
    }, context),
  ).rejects.toEqual({ type: "action", message: "Load the latest revision", data: {} })
  const defect = new Error("storage failure")
  await expect(
    exposeAction(async () => {
      throw defect
    }, context),
  ).rejects.toBe(defect)
})

test("only native missing-session errors match their exact target", () => {
  expect(isMissingSession({ _tag: "Session.NotFoundError", sessionID: "deleted" }, "deleted")).toBe(true)
  expect(isMissingSession({ _tag: "Session.NotFoundError", sessionID: "other" }, "deleted")).toBe(false)
  expect(isMissingSession(new Error("Session.NotFoundError"), "deleted")).toBe(false)
  expect(isMissingSession({ _tag: "TransportError", sessionID: "deleted" }, "deleted")).toBe(false)
})
