import type {
  ModelInfo,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
} from "@opencode/client"

export function errorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) return String(error.message)
  return String(error)
}

const stages: Record<string, string> = {
  redacting: "Preparing redacted content",
  awaiting_review: "Awaiting material review",
  awaiting_confirmation: "Awaiting outbound approval",
  preparing: "Preparing cloud collaboration",
  running: "Cloud collaboration running",
}
const outcomes = {
  succeeded: "Request finished",
  failed: "Request failed",
  interrupted: "Request interrupted",
}

export function currentQuery(messages: SessionMessageInfo[]) {
  const index = messages.findLastIndex((message) => message.type === "user")
  return index < 0 ? [] : messages.slice(index)
}

export function routeDecision(session: Pick<SessionInfo, "metadata">, messages: SessionMessageInfo[]) {
  const user = currentQuery(messages)[0]
  const record = session.metadata?.xcospanRoute
  if (!record || typeof record !== "object" || !("messageID" in record) || record.messageID !== user?.id)
    return
  const value = record.result
  if (
    value &&
    typeof value === "object" &&
    "cloud" in value &&
    "reason" in value &&
    typeof value.cloud === "boolean" &&
    typeof value.reason === "string"
  )
    return { cloud: value.cloud, reason: value.reason }
}

export function elapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m" + (seconds % 60) + "s"
}

export function actionLabel(tool: SessionMessageAssistantTool): string {
  const title = tool.state.status === "streaming" ? undefined : tool.state.metadata?.title
  return typeof title === "string" && title.trim() ? title : tool.name
}

export function actionDetail(tool: SessionMessageAssistantTool): string {
  if (tool.state.status === "streaming") return ""
  if (tool.state.status === "error") return tool.state.error.message
  return Object.entries(tool.state.input)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => key + ": " + String(value))
    .join(" · ")
}

export const toolStatus = {
  streaming: "Preparing",
  running: "Running",
  completed: "Completed",
  error: "Failed",
}

export function loopActivity(messages: SessionMessageInfo[], running: boolean) {
  const current = currentQuery(messages)
  const steps = current.filter((message) => message.type === "assistant")
  const tools = steps.flatMap((step) => step.content.filter((part) => part.type === "tool"))
  const active = tools.filter((tool) => tool.state.status === "running" || tool.state.status === "streaming")
  const last = steps.at(-1)
  const idle = current.findLast((message) => message.type === "idle")
  const part = last?.content.at(-1)
  const retry = running && !last?.finish ? last?.retry : undefined
  const compaction = current.at(-1)
  let label = "Waiting for response"
  if (!running)
    label =
      idle?.outcome === "succeeded"
        ? "Completed"
        : idle?.outcome === "failed"
          ? "Execution failed"
          : idle?.outcome === "interrupted"
            ? "Interrupted"
            : "Waiting to start"
  else if (active.length)
    label = active.map((tool) => actionLabel(tool) + " · " + toolStatus[tool.state.status]).join(" / ")
  else if (retry) label = "Retry attempt " + retry.attempt
  else if (compaction?.type === "compaction" && compaction.status === "running") label = "Compacting context"
  else if (part?.type === "text" && !last?.finish) label = "Generating response"
  else if (part?.type === "reasoning" && !last?.finish) label = "Reasoning"
  else if (last?.finish === "tool-calls") label = "Operations finished; waiting for the next step"
  else if (last?.finish) label = "Waiting for completion"
  const text =
    last?.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? ""
  const reasoning =
    last?.content.filter((item) => item.type === "reasoning").reduce((n, item) => n + item.text.length, 0) ??
    0
  return {
    label,
    steps,
    tools,
    active,
    text,
    reasoning,
    retry,
    error: sessionFailure(current) ?? last?.error?.message,
    started: current[0]?.time.created,
    ended: !running ? idle?.time.created : undefined,
  }
}

export function collaborationStage(
  session: Pick<SessionInfo, "outcome" | "metadata">,
  messages: SessionMessageInfo[],
  running: boolean,
): string {
  if (!running) return session.outcome ? outcomes[session.outcome] : "Waiting for a task"
  const route = session.metadata?.xcospanRoute
  if (
    route &&
    typeof route === "object" &&
    "status" in route &&
    route.status === "running" &&
    route.messageID === currentQuery(messages)[0]?.id
  )
    return "Routing this request"
  const start = messages.findLastIndex((message) => message.type === "user")
  const calls = messages
    .slice(start + 1)
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .filter((part) => part.type === "tool")
  const active = calls.filter((part) => part.state.status === "running")
  const labels = active.flatMap((part) => {
    if (!["redact", "redact_image", "cloud_delegate"].includes(part.name)) return []
    const state = part.state
    const status = state.status === "running" ? state.metadata.status : undefined
    return typeof status === "string" && stages[status] ? [stages[status]!] : []
  })
  if (labels.length) return [...new Set(labels)].join(" · ")
  if (calls.some((part) => part.name === "cloud_delegate" && part.state.status === "completed"))
    return "Local verification and delivery"
  return routeDecision(session, messages)?.cloud ? "Preparing cloud collaboration" : "Local execution"
}

export function collaborationErrors(messages: SessionMessageInfo[]) {
  const start = messages.findLastIndex((message) => message.type === "user")
  return messages
    .slice(start + 1)
    .flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part) =>
            part.type === "tool" &&
            ["redact", "redact_image", "cloud_delegate"].includes(part.name) &&
            part.state.status === "error"
              ? [{ id: part.id, name: part.name, message: part.state.error.message }]
              : [],
          )
        : [],
    )
}

export function sessionFailure(messages: SessionMessageInfo[]): string | undefined {
  const last = messages.at(-1)
  return last?.type === "idle" && last.outcome === "failed" ? last.error?.message : undefined
}

export function sessionExpense(
  messages: SessionMessageInfo[],
  models: Pick<ModelInfo, "id" | "providerID" | "cost">[],
): string {
  const completed = messages
    .filter((message) => message.type === "assistant")
    .filter((message) => message.finish)
  if (!completed.length) return "No completed calls"
  const priced = completed.every(
    (message) =>
      message.type === "assistant" &&
      message.cost !== undefined &&
      message.tokens !== undefined &&
      models.some(
        (model) =>
          model.providerID === message.model.providerID &&
          model.id === message.model.id &&
          model.cost.length > 0,
      ),
  )
  if (!priced) return "Cost unknown"
  const cost = completed.reduce((total, message) => total + message.cost!, 0)
  return "Estimated cost for loaded calls $" + cost.toFixed(6)
}
