import { usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { SessionInfo } from "@opencode/client"
import { createMemo, createSignal, createResource, For, Show, createEffect, on, onCleanup } from "solid-js"
import { CLOUD_AGENT, PRIMARY_AGENT } from "../delegate"
import { XCoSpan } from "../rpc"
import {
  collaborationStage,
  collaborationErrors,
  sessionExpense,
  sessionFailure,
  errorMessage,
  currentQuery,
  routeDecision,
  loopActivity,
  toolStatus,
  elapsed,
  actionLabel,
  actionDetail,
} from "../status"

function useSession(sessionID: () => string) {
  const ctx = usePlugin()
  return {
    session: () => ctx.data.session.get(sessionID()),
    messages: () => ctx.data.session.message.list(sessionID()),
    running: () => ctx.data.session.status(sessionID()) === "running",
  }
}

function CloudActivity(props: { sessionID: string }) {
  const ctx = usePlugin()
  const state = useSession(() => props.sessionID)
  createEffect(
    on(
      () => props.sessionID,
      (sessionID) => {
        void ctx.data.session.message
          .sync(sessionID)
          .catch((error) => ctx.ui.toast.show({ message: errorMessage(error), variant: "error" }))
      },
    ),
  )
  const activity = createMemo(() => loopActivity(state.messages(), state.running()).label)
  return (
    <text
      fg={ctx.theme.text.muted}
      onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: props.sessionID })}
    >
      Cloud activity · {activity()} · click for details
    </text>
  )
}

function ExecutionActivity(props: { sessionID: string; cloud?: boolean; details?: boolean }) {
  const ctx = usePlugin()
  const state = useSession(() => props.sessionID)
  const [now, setNow] = createSignal(Date.now())
  const [eventAt, setEventAt] = createSignal<number>()
  const [loadError, setLoadError] = createSignal<string>()
  const [loaded, setLoaded] = createSignal(false)
  const activity = createMemo(() => loopActivity(state.messages(), state.running()))
  const sync = async () => {
    try {
      await ctx.data.session.message.sync(props.sessionID)
      setLoadError(undefined)
      setLoaded(true)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }
  createEffect(
    on(
      () => props.sessionID,
      () => {
        setLoaded(false)
        setEventAt(undefined)
        void sync()
      },
    ),
  )
  createEffect(
    on(
      () => currentQuery(state.messages())[0]?.id,
      () => setEventAt(undefined),
    ),
  )
  onCleanup(
    ctx.data.on("server.connected", () => {
      void sync()
    }),
  )
  onCleanup(
    ctx.data.listen(({ details }) => {
      if (
        details.type.startsWith("session.") &&
        "sessionID" in details.data &&
        details.data.sessionID === props.sessionID
      )
        setEventAt(Date.now())
    }),
  )
  createEffect(() => {
    if (!state.running()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const model = () => activity().steps.at(-1)?.model ?? state.session()?.model
  return (
    <box flexDirection="column" gap={0}>
      <Show when={loadError()}>
        {(error) => (
          <text fg={ctx.theme.text.error} onMouseUp={() => void sync()}>
            Failed to load activity: {error()} · click to retry
          </text>
        )}
      </Show>
      <Show when={loaded()} fallback={<text fg={ctx.theme.text.muted}>Syncing session history...</text>}>
        <text fg={ctx.theme.text.accent}>
          {props.cloud ? "Cloud collaboration" : "Local work"} · {activity().label}
        </text>
        <Show when={model()}>
          {(value) => (
            <text fg={ctx.theme.text.muted}>
              {value().providerID}/{value().id}
            </text>
          )}
        </Show>
        <Show when={activity().started !== undefined}>
          <text fg={ctx.theme.text.muted}>
            Elapsed {elapsed((activity().ended ?? now()) - activity().started!)}
            {state.running()
              ? eventAt() === undefined
                ? " · Waiting for updates"
                : " · Updated " + elapsed(now() - eventAt()!) + " ago"
              : ""}
          </text>
        </Show>
        <Show when={activity().steps.length}>
          <text fg={ctx.theme.text.muted}>
            {activity().steps.length} steps ·{" "}
            {activity().tools.filter((t) => t.state.status === "completed").length} operations completed
          </text>
        </Show>
        <Show when={activity().retry}>
          {(retry) => <text fg={ctx.theme.text.error}>{retry().error.message}</text>}
        </Show>
        <Show when={activity().error}>{(error) => <text fg={ctx.theme.text.error}>{error()}</text>}</Show>
        <Show when={props.details || state.running() || !props.cloud}>
          <For each={activity().steps.slice(-2)}>
            {(step, index) => (
              <box flexDirection="column" paddingTop={1}>
                <text fg={ctx.theme.text.base}>
                  {step.error ? "×" : step.finish ? "✓" : "●"} Step{" "}
                  {Math.max(0, activity().steps.length - 2) + index() + 1}
                  {step.finish
                    ? " · Responded"
                    : step.content.length
                      ? " · In progress"
                      : " · Waiting for response"}
                </text>
                <For each={step.content.filter((part) => part.type === "tool")}>
                  {(tool) => (
                    <box flexDirection="column">
                      <text fg={tool.state.status === "error" ? ctx.theme.text.error : ctx.theme.text.muted}>
                        {tool.state.status === "completed" ? "✓" : tool.state.status === "error" ? "×" : "●"}{" "}
                        {actionLabel(tool)} · {toolStatus[tool.state.status]}
                        {tool.time.completed !== undefined
                          ? " · " + elapsed(tool.time.completed - (tool.time.ran ?? tool.time.created))
                          : ""}
                      </text>
                      <Show when={actionDetail(tool)}>
                        <text fg={ctx.theme.text.muted}>
                          {actionDetail(tool).replace(/\s+/g, " ").slice(0, 96)}
                          {actionDetail(tool).length > 96 ? "…" : ""}
                        </text>
                      </Show>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
          <Show when={state.running() && activity().reasoning > 0}>
            <text fg={ctx.theme.text.muted}>
              Reasoning received: {activity().reasoning.toLocaleString()} characters
            </text>
          </Show>
          <Show when={activity().text}>
            <text fg={ctx.theme.text.muted}>
              Latest progress · {activity().text.length > 100 ? "…" : ""}
              {activity().text.slice(-100).replace(/\s+/g, " ")}
            </text>
          </Show>
        </Show>
        <Show when={props.cloud && state.session()}>
          {(session) => (
            <text fg={ctx.theme.text.muted}>
              Usage · input {session().tokens.input.toLocaleString()} / output{" "}
              {session().tokens.output.toLocaleString()}
            </text>
          )}
        </Show>
      </Show>
      <Show when={props.cloud}>
        <text
          fg={ctx.theme.text.accent}
          onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: props.sessionID })}
        >
          View full activity →
        </text>
      </Show>
    </box>
  )
}

export function CollaborationSidebar(props: { sessionID: string }) {
  const ctx = usePlugin()
  const state = useSession(() => props.sessionID)
  const current = createMemo(() => currentQuery(state.messages()))
  const tools = createMemo(() =>
    current().flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    ),
  )
  const children = createMemo(() =>
    ctx.data.session
      .list()
      .filter(
        (session) =>
          session.parentID === props.sessionID &&
          session.agent === CLOUD_AGENT &&
          current()[0] &&
          session.time.created >= current()[0]!.time.created,
      ),
  )
  const route = () => (state.session() ? routeDecision(state.session()!, state.messages()) : undefined)
  const rpc = ctx.client.rpc(XCoSpan)
  const [record, { refetch }] = createResource(
    () => state.session()?.agent === PRIMARY_AGENT && props.sessionID,
    (sessionID) => rpc.list({ sessionID }, { location: ctx.data.session.get(sessionID)!.location }),
  )
  onCleanup(
    rpc.events.on("changed", (event) => {
      if (event.data.sessionID === props.sessionID) void refetch()
    }),
  )
  onCleanup(
    ctx.data.on("server.connected", () => {
      void refetch()
    }),
  )
  const reviews = () =>
    record.error
      ? []
      : (record()?.reviews ?? []).filter((review) => tools().some((tool) => tool.id === review.callID))
  const redactions = () => reviews().filter((review) => review.kind === "redaction")
  const delegations = () => tools().filter((tool) => tool.name === "cloud_delegate")
  const confirmed = () =>
    reviews().filter((review) => review.kind === "outbound" && review.status === "approved").length
  const pending = () =>
    tools().some(
      (tool) =>
        tool.state.status === "running" &&
        ["awaiting_review", "awaiting_confirmation"].includes(String(tool.state.metadata.status)),
    )
  return (
    <Show when={state.session()?.agent === PRIMARY_AGENT}>
      <box flexDirection="column" gap={1} paddingBottom={1}>
        <text fg={ctx.theme.text.accent}>
          <b>XCoSpan · Current request</b>
        </text>
        <text fg={pending() ? ctx.theme.text.warning : ctx.theme.text.base}>
          {collaborationStage(state.session()!, state.messages(), state.running())}
        </text>
        <Show when={route()}>
          {(decision) => (
            <text fg={ctx.theme.text.muted}>
              ✓ Route: {decision().cloud ? "Cloud collaboration" : "Local execution"}
            </text>
          )}
        </Show>
        <Show when={record.error}>
          <text fg={ctx.theme.text.error} onMouseUp={() => void refetch()}>
            Failed to load reviews · click to retry
          </text>
        </Show>
        <Show when={redactions().length}>
          <text fg={ctx.theme.text.muted}>
            Material reviews · {redactions().filter((review) => review.status === "approved").length}/
            {redactions().length} approved
          </text>
        </Show>
        <Show when={delegations().length}>
          <text fg={ctx.theme.text.muted}>
            {record.error
              ? "Failed to load outbound records"
              : !record()
                ? "Syncing outbound records"
                : "Outbound approvals · " + confirmed() + " approved"}
            {"\n"}
            Results returned · {delegations().filter((tool) => tool.state.status === "completed").length}{" "}
            completed
          </text>
        </Show>
        <Show when={pending()}>
          <text fg={ctx.theme.text.warning} onMouseUp={() => ctx.keymap.dispatch("xcospan.review")}>
            Awaiting your review · /xcospan-review
          </text>
        </Show>
        <Show when={!children().some((child) => ctx.data.session.status(child.id) === "running")}>
          <ExecutionActivity sessionID={props.sessionID} />
        </Show>
        <For each={children()}>{(child) => <ExecutionActivity sessionID={child.id} cloud />}</For>
        <Show when={collaborationErrors(state.messages()).length}>
          <text fg={ctx.theme.text.error} onMouseUp={() => ctx.ui.panel.open("xcospan.status")}>
            {collaborationErrors(state.messages()).length} operations failed · view details
          </text>
        </Show>
        <text fg={ctx.theme.text.accent} onMouseUp={() => ctx.ui.panel.open("xcospan.status")}>
          Progress and usage · /xcospan-status
        </text>
        <Show when={state.running()}>
          <text fg={ctx.theme.text.accent} onMouseUp={() => ctx.keymap.dispatch("xcospan.manage")}>
            Manage / stop · /xcospan
          </text>
        </Show>
        <Show when={children().some((child) => ctx.data.session.status(child.id) === "running")}>
          <text fg={ctx.theme.text.accent} onMouseUp={() => ctx.keymap.dispatch("xcospan.cancel")}>
            Cancel cloud task · /xcospan-cancel
          </text>
        </Show>
      </box>
    </Show>
  )
}

export function CollaborationBadge(props: { sessionID: string }) {
  const ctx = usePlugin()
  const state = useSession(() => props.sessionID)
  return (
    <Show when={state.session()?.agent === PRIMARY_AGENT}>
      <box flexDirection="column">
        <text fg={ctx.theme.text.accent} onMouseUp={() => ctx.ui.panel.open("xcospan.status")}>
          XCoSpan · {collaborationStage(state.session()!, state.messages(), state.running())}
          {"  "} /xcospan-status View progress and usage
        </text>
        <For
          each={ctx.data.session
            .list()
            .filter(
              (session) =>
                session.parentID === props.sessionID &&
                session.agent === CLOUD_AGENT &&
                ctx.data.session.status(session.id) === "running",
            )}
        >
          {(child) => <CloudActivity sessionID={child.id} />}
        </For>
        <Show when={collaborationErrors(state.messages()).at(-1)}>
          {(error) => <text fg={ctx.theme.text.error}>Request failed · {error().message}</text>}
        </Show>
        <Show when={!state.running() && sessionFailure(state.messages())}>
          {(message) => <text fg={ctx.theme.text.error}>{message()}</text>}
        </Show>
      </box>
    </Show>
  )
}

function Usage(props: { session: SessionInfo; label: string }) {
  const ctx = usePlugin()
  createEffect(() => {
    void ctx.data.session.message
      .sync(props.session.id)
      .catch((error) =>
        ctx.ui.toast.show({ title: "Failed to load usage", message: errorMessage(error), variant: "error" }),
      )
  })
  const messages = () => ctx.data.session.message.list(props.session.id)
  const last = () => messages().findLast((message) => message.type === "assistant")
  const model = () => last()?.model ?? props.session.model
  const models = () => ctx.data.location.model.list(props.session.location) ?? []
  const tokens = () => props.session.tokens
  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <text fg={ctx.theme.text.base}>
        <b>{props.label}</b>
      </text>
      <text fg={ctx.theme.text.muted}>
        {model() ? model()!.providerID + "/" + model()!.id : "No calls recorded"}
      </text>
      <text fg={ctx.theme.text.base}>
        Input {tokens().input.toLocaleString()} · output {tokens().output.toLocaleString()}
        {"\n"}Reasoning {tokens().reasoning.toLocaleString()}
        {"\n"}Cache read {tokens().cache.read.toLocaleString()} · write{" "}
        {tokens().cache.write.toLocaleString()}
      </text>
      <text fg={ctx.theme.text.muted}>{sessionExpense(messages(), models())}</text>
      <Show when={ctx.data.session.status(props.session.id) === "running" && last()?.retry}>
        {(retry) => (
          <text fg={ctx.theme.text.accent}>
            Retry attempt {retry().attempt}
            {"\n"}
            {retry().error.message}
          </text>
        )}
      </Show>
      <Show when={ctx.data.session.status(props.session.id) !== "running" && sessionFailure(messages())}>
        {(message) => <text fg={ctx.theme.text.error}>Request failed: {message()}</text>}
      </Show>
    </box>
  )
}

export function CollaborationPanel(props: { panel: PanelInput }) {
  const ctx = usePlugin()
  const state = useSession(() => props.panel.sessionID)
  const children = createMemo(() =>
    ctx.data.session
      .list()
      .filter(
        (session) =>
          session.parentID === props.panel.sessionID &&
          session.agent === CLOUD_AGENT &&
          typeof session.metadata?.xcospanRun === "string",
      ),
  )
  const route = () => (state.session() ? routeDecision(state.session()!, state.messages()) : undefined)
  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [{ bind: "escape", title: "Close collaboration status", run: props.panel.close }],
  }))
  return (
    <scrollbox flexGrow={1} padding={2}>
      <box flexDirection="column" gap={1}>
        <text fg={ctx.theme.text.accent}>
          <b>XCoSpan · Progress and usage</b>
        </text>
        <Show when={state.session()}>
          {(session) => (
            <>
              <text fg={ctx.theme.text.base}>
                {collaborationStage(session(), state.messages(), state.running())}
              </text>
              <Show when={route()}>
                {(decision) => (
                  <box flexDirection="column">
                    <text fg={ctx.theme.text.base}>
                      Route: {decision().cloud ? "Cloud collaboration" : "Local execution"}
                    </text>
                    <text fg={ctx.theme.text.muted}>{decision().reason}</text>
                  </box>
                )}
              </Show>
              <text fg={ctx.theme.text.muted}>
                Review every redaction; cloud collaboration starts after outbound approval.
              </text>
              <For each={collaborationErrors(state.messages())}>
                {(error) => <text fg={ctx.theme.text.error}>Request failed · {error.message}</text>}
              </For>
              <Usage session={session()} label="Local work · Total usage" />
            </>
          )}
        </Show>
        <For each={children()}>
          {(child, index) => (
            <box flexDirection="column" gap={1}>
              <ExecutionActivity sessionID={child.id} cloud details />
              <Usage session={child} label={"Cloud collaboration " + (index() + 1) + " · Total usage"} />
              <text
                fg={ctx.theme.text.accent}
                onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: child.id })}
              >
                View cloud activity →
              </text>
            </box>
          )}
        </For>
        <text fg={ctx.theme.text.muted}>
          Totals cover recorded task calls. Routing and redaction usage is excluded.
          {"\n"}/xcospan-review Review · /xcospan-cancel Cancel cloud task · /xcospan-recover Recover results
          {"\n"}Esc close
        </text>
      </box>
    </scrollbox>
  )
}
