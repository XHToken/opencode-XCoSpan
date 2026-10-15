import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { ImageRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { Content, Task } from "../types"

export function reviewImages(content: Content | Task, label: string) {
  return ("goal" in content ? content.materials : [content]).flatMap((item, index) =>
    item.type === "image" ? [{ image: item, label: `${label} · Image ${index + 1}` }] : [],
  )
}

export function ReviewImages(props: {
  images: ReturnType<typeof reviewImages>
  failed(error: unknown): void
}) {
  const ctx = usePlugin()
  let viewport: ScrollBoxRenderable
  let image: ImageRenderable
  const [index, setIndex] = createSignal(0)
  const [zoom, setZoom] = createSignal(1)
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const [view, setView] = createSignal({ width: 1, height: 1 })
  const fitted = () =>
    size().width ? image.getFittedSize(view().width, view().height) : { width: 1, height: 1 }
  const current = () => props.images[index()]!
  const source = createMemo(() => new Uint8Array(Buffer.from(current().image.data, "base64")))
  const resized = () => setView({ width: viewport.viewport.width, height: viewport.viewport.height })
  onCleanup(() => viewport.viewport.off("resize", resized))
  function reset() {
    setZoom(1)
    viewport.scrollTo({ x: 0, y: 0 })
  }
  function move(direction: number) {
    setSize({ width: 0, height: 0 })
    setIndex((index() + direction + props.images.length) % props.images.length)
    reset()
  }
  ctx.keymap.layer(() => ({
    mode: "modal",
    priority: 2,
    commands: [
      { bind: "tab", title: "Next image", run: () => move(1) },
      { bind: "shift+tab", title: "Previous image", run: () => move(-1) },
      {
        bind: "=",
        title: "Zoom in",
        run: () =>
          setZoom(
            Math.min(zoom() * 2, Math.max(1, size().width / fitted().width, size().height / fitted().height)),
          ),
      },
      { bind: "-", title: "Zoom out", run: () => setZoom(Math.max(1, zoom() / 2)) },
      { bind: "0", title: "Fit to viewport", run: reset },
      { bind: "up", title: "Pan up", run: () => viewport.scrollBy(-1) },
      { bind: "down", title: "Pan down", run: () => viewport.scrollBy(1) },
      { bind: "left", title: "Pan left", run: () => viewport.scrollBy({ x: -1, y: 0 }) },
      { bind: "right", title: "Pan right", run: () => viewport.scrollBy({ x: 1, y: 0 }) },
      { bind: "home", title: "Image start", run: () => viewport.scrollTo({ x: 0, y: 0 }) },
      {
        bind: "end",
        title: "Image end",
        run: () => viewport.scrollTo({ x: viewport.scrollWidth, y: viewport.scrollHeight }),
      },
      { bind: "pageup", title: "Previous page", run: () => viewport.scrollBy(-0.5, "viewport") },
      { bind: "pagedown", title: "Next page", run: () => viewport.scrollBy(0.5, "viewport") },
    ],
  }))
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1} gap={1}>
      <text flexShrink={0}>
        {current().label} · {index() + 1}/{props.images.length}
        <Show when={size().width} fallback=" · Loading">
          {" "}
          · {size().width}×{size().height}
        </Show>
        {" · "}
        {Math.round(zoom() * 100)}% viewport
      </text>
      <scrollbox
        ref={(value) => {
          viewport = value
          value.viewport.on("resize", resized)
        }}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={1}
        focused
        contentOptions={{
          maxWidth: Math.max(view().width, Math.floor(fitted().width * zoom())),
          width: Math.max(1, Math.floor(fitted().width * zoom())),
        }}
      >
        <image
          ref={(value) => {
            image = value
          }}
          source={source()}
          visible={size().width > 0}
          width={Math.max(1, Math.floor(fitted().width * zoom()))}
          height={Math.max(1, Math.floor(fitted().height * zoom()))}
          flexShrink={0}
          fit="fit"
          onLoad={(image) => setSize({ width: image.width, height: image.height })}
          onError={props.failed}
        />
      </scrollbox>
      <text flexShrink={0}>＝/－ zoom · 0 Fit to viewport · ↑↓←→ pan</text>
      <text flexShrink={0}>Tab/Shift+Tab switch image · Ctrl+O return to review · Ctrl+X Cancel</text>
    </box>
  )
}
