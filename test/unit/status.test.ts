import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import {
  collaborationStage,
  collaborationErrors,
  sessionExpense,
  errorMessage,
  loopActivity,
  currentQuery,
  routeDecision,
  elapsed,
  actionLabel,
  actionDetail,
} from "../../src/status"

test("native RPC error objects display their actual message", () => {
  expect(errorMessage({ type: "RpcError", message: "Review changed" })).toBe("Review changed")
  expect(errorMessage(new Error("Disconnected"))).toBe("Disconnected")
})

const user: SessionMessageInfo = { type: "user", id: "msg_user", time: { created: 1 }, text: "task" }
function call(name: string, status: string): SessionMessageInfo {
  return {
    type: "assistant",
    id: "msg_call",
    time: { created: 2 },
    agent: "xcospan",
    model: { id: "local", providerID: "fixture" },
    content: [
      {
        type: "tool",
        id: "call_1",
        name,
        time: { created: 2 },
        state: { status: "running", input: {}, metadata: { status } },
      },
    ],
  }
}

test("stage follows review and cloud tool facts; old completion cannot describe a new query", () => {
  const session = { outcome: "succeeded" as const }
  expect(collaborationStage(session, [user, call("redact", "awaiting_review")], true)).toBe(
    "Awaiting material review",
  )
  expect(collaborationStage(session, [user, call("cloud_delegate", "awaiting_confirmation")], true)).toBe(
    "Awaiting outbound approval",
  )
  expect(collaborationStage(session, [user, call("cloud_delegate", "running")], true)).toBe(
    "Cloud collaboration running",
  )
  expect(collaborationStage(session, [user, call("cloud_delegate", "running"), user], true)).toBe(
    "Local execution",
  )
  expect(collaborationStage(session, [user], false)).toBe("Request finished")
  expect(collaborationStage({ outcome: "interrupted" }, [user], false)).toBe("Request interrupted")
})

test("tool errors stay attributed to the current query even when the parent ends normally", () => {
  const failed: SessionMessageInfo = {
    type: "assistant",
    id: "msg_failed",
    time: { created: 2 },
    agent: "xcospan",
    model: { id: "local", providerID: "fixture" },
    content: [
      {
        type: "tool",
        id: "call_failed",
        name: "redact",
        time: { created: 2 },
        state: { status: "error", input: {}, error: { type: "unknown", message: "Credential rejected" } },
      },
    ],
  }
  expect(collaborationErrors([user, failed])).toEqual([
    { id: "call_failed", name: "redact", message: "Credential rejected" },
  ])
  expect(collaborationErrors([user, failed, { ...user, id: "msg_next" }])).toEqual([])
})

test("concurrent redaction and delegation remain separately visible", () => {
  expect(
    collaborationStage(
      {},
      [user, call("redact", "awaiting_review"), call("cloud_delegate", "running")],
      true,
    ),
  ).toBe("Awaiting material review · Cloud collaboration running")
})

test("loop activity gives pending tools precedence over finished model output", () => {
  const assistant = call("websearch", "running")
  if (assistant.type !== "assistant") throw new Error("fixture")
  assistant.finish = "tool-calls"
  assistant.content.push({ type: "text", text: "Searching" })
  const activity = loopActivity([user, assistant], true)
  expect(activity.label).toBe("websearch · Running")
  expect(activity.steps).toHaveLength(1)
  expect(activity.active).toHaveLength(1)
  expect(activity.text).toBe("Searching")
})

test("loop feedback follows streaming, retries, final failure and each new query", () => {
  const assistant = call("read", "running")
  if (assistant.type !== "assistant") throw new Error("fixture")
  assistant.content = [{ type: "reasoning", text: "Thinking" }]
  expect(loopActivity([user, assistant], true)).toMatchObject({ label: "Reasoning", reasoning: 8 })
  assistant.content.push({ type: "text", text: "Partial answer" })
  expect(loopActivity([user, assistant], true).label).toBe("Generating response")
  assistant.retry = { attempt: 2, at: 300, error: { type: "unknown", message: "Rate limited" } }
  expect(loopActivity([user, assistant], true).label).toBe("Retry attempt 2")
  const idle: SessionMessageInfo = {
    type: "idle",
    id: "idle",
    time: { created: 1000 },
    outcome: "failed",
    error: { type: "unknown", message: "Disconnected" },
  }
  expect(loopActivity([user, assistant, idle], false)).toMatchObject({
    label: "Execution failed",
    error: "Disconnected",
    ended: 1000,
    retry: undefined,
  })
  const next = { ...user, id: "next", time: { created: 2000 } }
  expect(loopActivity([user, assistant, idle, next], true)).toMatchObject({
    label: "Waiting for response",
    steps: [],
    tools: [],
    started: 2000,
    ended: undefined,
  })
  expect(currentQuery([assistant])).toEqual([])
})

test("arbitrary actions keep their actual title, inputs and errors without a name mapping", () => {
  const step = call("custom_spreadsheet_audit", "running")
  if (step.type !== "assistant") throw new Error("fixture")
  const tool = step.content[0]!
  if (tool.type !== "tool" || tool.state.status !== "running") throw new Error("fixture")
  tool.state.input = { sheet: "2026 Sales", region: "C2:E9" }
  expect(actionLabel(tool)).toBe("custom_spreadsheet_audit")
  expect(actionDetail(tool)).toBe("sheet: 2026 Sales · region: C2:E9")
  tool.state.metadata.title = "Verify Q3 amounts"
  expect(actionLabel(tool)).toBe("Verify Q3 amounts")
  expect(loopActivity([user, step], true).label).toBe("Verify Q3 amounts · Running")
})

test("route belongs to current query; pending routing has no completed decision", () => {
  const metadata = { xcospanRoute: { messageID: user.id, result: { cloud: true, reason: "Research" } } }
  expect(routeDecision({ metadata }, [user])).toEqual({ cloud: true, reason: "Research" })
  expect(collaborationStage({ metadata }, [user], true)).toBe("Preparing cloud collaboration")
  expect(collaborationStage({ metadata }, [{ ...user, id: "next" }], true)).toBe("Local execution")
  expect(routeDecision({ metadata }, [{ ...user, id: "next" }])).toBeUndefined()
  expect(
    routeDecision({ metadata: { xcospanRoute: { messageID: user.id, status: "running" } } }, [user]),
  ).toBeUndefined()
  expect(elapsed(61000)).toBe("1m1s")
})

test("unpriced or missing usage stays unknown; explicit zero pricing is distinguishable", () => {
  const message: SessionMessageInfo = {
    type: "assistant",
    id: "msg_result",
    time: { created: 2 },
    agent: "xcospan",
    model: { id: "local", providerID: "fixture" },
    content: [],
    finish: "stop",
    cost: 0,
    tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  expect(sessionExpense([message], [])).toBe("Cost unknown")
  const free = {
    id: "local",
    providerID: "fixture",
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  }
  expect(sessionExpense([message], [free])).toBe("Estimated cost for loaded calls $0.000000")
  expect(sessionExpense([{ ...message, tokens: undefined }], [free])).toBe("Cost unknown")
  expect(sessionExpense([], [])).toBe("No completed calls")
})
