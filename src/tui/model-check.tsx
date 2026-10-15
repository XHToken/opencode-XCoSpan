import { createSignal, For, onMount, onCleanup } from "solid-js"
import { usePlugin, type Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { RpcCallOptions } from "@opencode/client/promise/api"
import { XCoSpan } from "../rpc"
import { errorMessage } from "../status"

type Model = { providerID: string; id: string }
export type ModelCheck = { role: string; model: Model; status: string }
export function checkModels(ctx: Plugin.Context, models: Model[], options: RpcCallOptions) {
  return new Promise<ModelCheck[]>((resolve) => {
    let result = models.map((model, i) => ({
      role: i === 0 ? "Local model" : "Cloud model",
      model,
      status: "Not checked",
    }))
    ctx.ui.dialog.show(
      () => (
        <Checks
          initial={result}
          options={options}
          changed={(next) => {
            result = next
          }}
        />
      ),
      () => resolve(result),
    )
    ctx.ui.dialog.set({ size: "large", centered: true })
  })
}
function Checks(props: {
  initial: ModelCheck[]
  options: RpcCallOptions
  changed(next: ModelCheck[]): void
}) {
  const ctx = usePlugin()
  const dimensions = useTerminalDimensions()
  const client = ctx.client.rpc(XCoSpan)
  const controller = new AbortController()
  const [rows, setRows] = createSignal(props.initial)
  const [done, setDone] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)
  let disposed = false
  function update(index: number, status: string) {
    const next = rows().map((row, i) => (i === index ? { ...row, status } : row))
    setRows(next)
    props.changed(next)
  }
  function cancel() {
    if (done()) return ctx.ui.dialog.clear()
    setCancelling(true)
    controller.abort()
  }
  onCleanup(() => {
    disposed = true
    controller.abort()
    rows().forEach((row, i) => {
      if (row.status === "Checking") update(i, "Cancelled")
    })
  })
  onMount(() => {
    void (async () => {
      for (let i = 0; i < rows().length; i++) {
        if (controller.signal.aborted) break
        update(i, "Checking")
        try {
          const result = await client.testModel(rows()[i]!.model, {
            ...props.options,
            signal: controller.signal,
          })
          update(i, "Passed: " + result.text)
        } catch (error) {
          update(i, controller.signal.aborted ? "Cancelled" : "Failed: " + errorMessage(error))
        }
      }
      if (!disposed) setDone(true)
    })()
  })
  ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "escape", title: "Cancel check / back", run: cancel },
      { bind: "ctrl+x", title: "Cancel check", run: cancel },
      {
        bind: "return",
        title: "Back to setup",
        run: () => {
          if (done()) ctx.ui.dialog.clear()
        },
      },
    ],
  }))
  return (
    <box flexDirection="column" padding={1} gap={1} height={Math.min(20, dimensions().height - 2)}>
      <text flexShrink={0}>
        {done() ? "Model check results" : "Checking model connection and tool calling"}
      </text>
      <scrollbox
        wrapperOptions={{ flexBasis: 0, flexShrink: 1, minWidth: 0 }}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={1}
        focused
      >
        <For each={rows()}>
          {(row) => (
            <box flexDirection="column" marginBottom={1}>
              <text>
                {row.role} · {row.model.providerID}/{row.model.id}
              </text>
              <text>{row.status}</text>
            </box>
          )}
        </For>
        <text fg={ctx.theme.text.muted}>Checks use synthetic data and incur provider usage.</text>
      </scrollbox>
      <text flexShrink={0}>
        {done()
          ? "Enter / Esc Back to setup"
          : cancelling()
            ? "Cancelling checks..."
            : "Esc / Ctrl+X Cancel check"}
      </text>
    </box>
  )
}
