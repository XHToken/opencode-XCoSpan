import { createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { isAbsolute } from "node:path"
import { usePlugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { Review, Content, Task } from "../types"
import type { XCoSpan } from "../rpc"
import type { RpcClient, RpcCallOptions } from "@opencode/client/promise/api"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { errorMessage } from "../status"
import { Image, imageURI } from "../types"
import { reviewImages, ReviewImages } from "./review-images"

type ReviewClient = Pick<RpcClient<typeof XCoSpan>, "get" | "edit" | "approve" | "cancel" | "events">
type Field = { label: string; value: string; set(value: string): void }

function ContentView(props: {
  content: Content | Task
  ready?(data: string): void
  failed?(error: unknown): void
}) {
  const texts = () =>
    "instructions" in props.content
      ? [
          { label: "Task instructions", text: props.content.instructions },
          ...props.content.materials.flatMap((item, index) =>
            item.type === "text" ? [{ label: `Material ${index + 1}`, text: item.text }] : [],
          ),
        ]
      : props.content.type === "text"
        ? [{ label: "", text: props.content.text }]
        : []
  const images = () =>
    ("instructions" in props.content ? props.content.materials : [props.content]).flatMap((item, index) =>
      item.type === "image" ? [{ item, index }] : [],
    )
  return (
    <box flexDirection="column" gap={1}>
      <For each={texts()}>
        {(section) => (
          <box flexDirection="column">
            <Show when={section.label}>
              <text>[{section.label}]</text>
            </Show>
            <text>{section.text}</text>
          </box>
        )}
      </For>
      <For each={images()}>
        {({ item, index }) => {
          const [size, setSize] = createSignal("")
          return (
            <box flexDirection="column">
              <text>
                [Image {index + 1}]{size()}
              </text>
              <image
                source={new Uint8Array(Buffer.from(item.data, "base64"))}
                height={18}
                width="100%"
                onLoad={(image) => {
                  setSize(`${image.width}×${image.height}`)
                  props.ready?.(item.data)
                }}
                onError={props.failed}
              />
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function ReviewDialog(props: {
  initial: Review
  client: ReviewClient
  options: RpcCallOptions
  finished(): void
}) {
  const ctx = usePlugin()
  const dimensions = useTerminalDimensions()
  let preview: ScrollBoxRenderable
  let input: TextareaRenderable
  const [review, setReview] = createSignal(props.initial)
  const [newer, setNewer] = createSignal<Review>()
  let closed = false
  const [draft, setDraft] = createSignal(structuredClone(props.initial.candidate))
  const [editing, setEditing] = createSignal(false)
  const [comparing, setComparing] = createSignal(props.initial.kind === "redaction")
  const [viewingImages, setViewingImages] = createSignal(false)
  const [columnWidth, setColumnWidth] = createSignal(1)
  const images = createMemo(() => [
    ...reviewImages(
      review().original,
      review().kind === "redaction" ? "Original content" : "Submitted content",
    ),
    ...reviewImages(draft(), "Current candidate"),
  ])
  const [field, setField] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [imageError, setImageError] = createSignal(false)
  const [loaded, setLoaded] = createSignal(new Set<string>())
  const [replacements, setReplacements] = createSignal<Record<number, string>>({})
  const dirty = () =>
    Object.values(replacements()).some(Boolean) ||
    JSON.stringify(draft()) !== JSON.stringify(review().candidate)
  const imagesReady = () =>
    (comparing() ? [review().original, draft()] : [draft()]).every((content) => {
      const materials = "instructions" in content ? content.materials : [content]
      return materials.every((item) => item.type !== "image" || loaded().has(item.data))
    })
  const ready = (data: string) => setLoaded((previous) => new Set([...previous, data]))
  const replacement = (index: number): Field => ({
    label: `Image ${index + 1}: absolute replacement path (leave blank to keep the current image)`,
    value: replacements()[index] ?? "",
    set: (value) => setReplacements((previous) => ({ ...previous, [index]: value })),
  })
  function update(fn: (candidate: Content | Task) => void) {
    const copy = structuredClone(draft())
    fn(copy)
    setDraft(copy)
  }
  const fields = createMemo(() => {
    const candidate = draft()
    const result: Field[] = []
    if ("instructions" in candidate) {
      result.push({
        label: "Task instructions",
        value: candidate.instructions,
        set: (value) =>
          update((item) => {
            if ("instructions" in item) item.instructions = value
          }),
      })
      candidate.materials.forEach((item, index) => {
        if (item.type === "text")
          result.push({
            label: `Material ${index + 1}`,
            value: item.text,
            set: (value) =>
              update((value2) => {
                if ("instructions" in value2) {
                  const material = value2.materials[index]
                  if (material?.type === "text") material.text = value
                }
              }),
          })
        else result.push(replacement(index))
      })
    } else if (candidate.type === "text")
      result.push({
        label: "Redacted content",
        value: candidate.text,
        set: (value) =>
          update((item) => {
            if ("type" in item && item.type === "text") item.text = value
          }),
      })
    else result.push(replacement(0))
    return result
  })
  function finish() {
    if (closed) return
    closed = true
    props.finished()
    ctx.ui.dialog.clear()
  }
  function adopt(next: Review) {
    if (closed || next.revision < review().revision) return
    setViewingImages(false)
    setReview(next)
    setDraft(structuredClone(next.candidate))
    setReplacements({})
    setImageError(false)
    setField(0)
    setEditing(false)
    setError("")
    if ((newer()?.revision ?? 0) <= next.revision) setNewer(undefined)
  }
  async function refresh(reload = false) {
    const next = await props.client.get({ id: review().id, sessionID: review().sessionID }, props.options)
    if (closed) return
    if (next.status !== "pending") {
      const messages = {
        approved: "Review approved",
        cancelled: "Review cancelled",
        interrupted: "Review interrupted",
      }
      ctx.ui.toast.show({ message: messages[next.status] })
      finish()
      return
    }
    if (reload) {
      adopt(next)
      return
    }
    if (next.revision <= Math.max(review().revision, newer()?.revision ?? 0)) return
    if (dirty() || editing() || busy()) setNewer(next)
    else adopt(next)
  }
  const stop = props.client.events.on("changed", (event) => {
    if (event.data.id === review().id && event.data.sessionID === review().sessionID)
      void refresh().catch((error) => {
        if (!closed) setError(errorMessage(error))
      })
  })
  // Subscribe before loading the current record so changes during dialog creation are observed.
  void refresh().catch((error) => {
    if (!closed) setError(errorMessage(error))
  })
  const reconnected = ctx.data.on("server.connected", () => {
    void refresh().catch((error) => {
      if (!closed) setError(errorMessage(error))
    })
  })
  onCleanup(() => {
    closed = true
    stop()
    reconnected()
  })

  async function action(fn: () => Promise<void>) {
    if (busy() || closed) return
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  // Session-level paging closes dialogs; consume it in this modal and use the native viewport.
  function page(direction: number) {
    if (!editing()) {
      preview.scrollBy(direction / 2, "viewport")
      return
    }
    const view = input.editorView.getViewport()
    input.editorView.setViewport(
      view.offsetX,
      view.offsetY + direction * Math.floor(view.height / 2),
      view.width,
      view.height,
      true,
    )
    input.requestRender()
  }
  ctx.keymap.layer(() => ({
    mode: "modal",
    // Host global layers can register later while the session loads.
    priority: 1,
    commands: [
      {
        bind: "ctrl+d",
        title: "Toggle comparison",
        run: () => {
          if (!editing() && !viewingImages()) setComparing(!comparing())
        },
      },
      { bind: "pageup", title: "Previous page", run: () => page(-1) },
      { bind: "pagedown", title: "Next page", run: () => page(1) },
      {
        bind: "ctrl+o",
        title: "Open image viewer",
        enabled: () => !editing() && images().length > 0,
        run: () => {
          setError("")
          setViewingImages(!viewingImages())
        },
      },
      {
        bind: "ctrl+e",
        title: "Edit",
        run: () => {
          setViewingImages(false)
          if (fields().length) setEditing(!editing())
        },
      },
      {
        bind: "tab",
        title: "Next field",
        run: () => {
          if (editing()) setField((field() + 1) % fields().length)
        },
      },
      {
        bind: "shift+tab",
        title: "Previous field",
        run: () => {
          if (editing()) setField((field() + fields().length - 1) % fields().length)
        },
      },
      {
        bind: "ctrl+r",
        title: "Load latest revision (discard local edits)",
        run: () => action(() => refresh(true)),
      },
      {
        bind: "ctrl+s",
        title: "Save edits",
        run: () =>
          action(async () => {
            if (viewingImages()) throw new Error("Press Ctrl+O to return to review before saving")
            if (newer()) throw new Error("Load the latest revision before editing and saving")
            let candidate = structuredClone(draft())
            for (const [index, path] of Object.entries(replacements())) {
              if (!path) continue
              if (!isAbsolute(path)) throw new Error("Use an absolute image path")
              const file = Bun.file(path)
              const content = Image.parse({
                type: "image",
                mime: file.type,
                data: Buffer.from(await file.arrayBuffer()).toString("base64"),
              })
              imageURI(content)
              if ("instructions" in candidate) candidate.materials[Number(index)] = content
              else candidate = content
            }
            const next = await props.client.edit(
              {
                id: review().id,
                sessionID: review().sessionID,
                revision: review().revision,
                candidate,
              },
              props.options,
            )
            adopt(next)
          }),
      },
      {
        bind: "ctrl+a",
        title: "Approve",
        enabled: () => !editing(),
        run: () =>
          action(async () => {
            if (viewingImages()) throw new Error("Press Ctrl+O to return and inspect the complete candidate")
            if (newer()) throw new Error("Load and inspect the latest revision")
            if (dirty()) throw new Error("Save changes and inspect the complete candidate first")
            if (editing()) throw new Error("Return to preview and inspect the complete candidate")
            if (imageError()) throw new Error("Image preview failed; approval is unavailable")
            if (!imagesReady()) throw new Error("Wait for all images to finish loading")
            await props.client.approve(
              {
                id: review().id,
                sessionID: review().sessionID,
                revision: review().revision,
              },
              props.options,
            )
            finish()
          }),
      },
      {
        bind: "ctrl+x",
        title: "Cancel task",
        run: () =>
          action(async () => {
            await props.client.cancel({ id: review().id, sessionID: review().sessionID }, props.options)
            finish()
          }),
      },
    ],
  }))
  return (
    <box flexDirection="column" height={Math.min(36, dimensions().height - 2)} padding={1} gap={1}>
      <text flexShrink={0} fg={ctx.theme.text.base}>
        {review().kind === "redaction" ? "Material review" : "Outbound review"} · revision {review().revision}
      </text>
      <Show when={newer()}>
        <text flexShrink={0} fg={ctx.theme.text.base}>
          Another client saved revision {newer()?.revision}. Your local edits are retained; Ctrl+R loads the
          latest revision and discards them.
        </text>
      </Show>
      <Show when={error()}>
        <text flexShrink={0} fg="red">
          {error()}
        </text>
      </Show>
      <Show
        when={!viewingImages()}
        fallback={
          <ReviewImages
            images={images()}
            failed={(error) => {
              setImageError(true)
              setError(errorMessage(error))
            }}
          />
        }
      >
        <Show
          when={!editing()}
          fallback={
            <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
              <text flexShrink={0}>{fields()[field()]?.label} · Tab / Shift+Tab change fields</text>
              <For each={[field()]}>
                {(index) => {
                  return (
                    <textarea
                      ref={(value) => {
                        input = value
                      }}
                      initialValue={fields()[index]?.value ?? ""}
                      flexBasis={0}
                      flexGrow={1}
                      flexShrink={1}
                      minHeight={1}
                      focused
                      onContentChange={() => fields()[index]?.set(input.plainText)}
                    />
                  )
                }}
              </For>
            </box>
          }
        >
          <scrollbox
            wrapperOptions={{ flexBasis: 0, flexShrink: 1, minWidth: 0 }}
            ref={(value) => {
              preview = value
            }}
            flexBasis={0}
            flexGrow={1}
            flexShrink={1}
            minHeight={1}
            focused
          >
            <text marginBottom={1}>{review().note}</text>
            <box
              flexDirection="row"
              gap={2}
              onSizeChange={function () {
                // Equal integer widths keep text measurement and rendering on the same cell grid.
                setColumnWidth(Math.max(1, Math.floor((this.width - 2) / 2)))
              }}
            >
              <Show when={comparing()}>
                <box width={columnWidth()} flexDirection="column">
                  <text>{review().kind === "redaction" ? "Original content" : "Submitted content"}</text>
                  <ContentView
                    content={review().original}
                    ready={ready}
                    failed={() => {
                      setImageError(true)
                      setError("Original image preview failed")
                    }}
                  />
                </box>
              </Show>
              <box width={comparing() ? columnWidth() : "100%"} flexDirection="column">
                <text>Current candidate</text>
                <ContentView
                  content={draft()}
                  ready={ready}
                  failed={() => {
                    setImageError(true)
                    setError("Candidate image preview failed")
                  }}
                />
              </box>
            </box>
          </scrollbox>
        </Show>
        <Show when={!editing()}>
          <text flexShrink={0} fg={ctx.theme.text.muted}>
            ↑↓ scroll · PgUp/PgDn page · Home/End start/end · Ctrl+D {comparing() ? "single" : "compare"}
            {images().length ? " · Ctrl+O Open image viewer" : ""}
          </text>
        </Show>
        <text flexShrink={0}>
          {busy()
            ? "Processing..."
            : "Ctrl+E Edit · Ctrl+S Save · Ctrl+R Reload · Ctrl+A Approve · Ctrl+X Cancel task"}
        </text>
        <Show when={dirty()}>
          <text flexShrink={0} fg={ctx.theme.text.muted}>
            Unsaved changes
          </text>
        </Show>
      </Show>
    </box>
  )
}
