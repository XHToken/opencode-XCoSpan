import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, Show } from "solid-js"
import { CollaborationBadge, CollaborationPanel, CollaborationSidebar } from "./status"
import { errorMessage } from "../status"
import { PRIMARY_AGENT } from "../delegate"
import { XCoSpan } from "../rpc"
import { ReviewDialog } from "./review"
import { setupManagement } from "./setup"
import type { Review, Run } from "../types"

const runLabels: Record<Run["status"], string> = {
  prepared: "Preparing",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  unknown: "Status unknown",
}

export default Plugin.define({
  id: "xcospan-tui",
  setup(ctx) {
    const client = ctx.client.rpc(XCoSpan)
    const management = setupManagement(ctx)
    const [reviewing, setReviewing] = createSignal(false)
    ctx.ui.slot({
      append: "session.composer.top",
      render: (props) => <CollaborationBadge sessionID={props.sessionID} />,
    })
    ctx.ui.slot({
      prepend: "sidebar.content",
      render: (props) => (
        <Show when={!reviewing()}>
          <CollaborationSidebar sessionID={props.sessionID} />
        </Show>
      ),
    })
    ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "xcospan.status"}>
          <CollaborationPanel panel={panel} />
        </Show>
      ),
    })
    function atSession(sessionID: string) {
      const session = ctx.data.session.get(sessionID)
      if (!session) throw new Error("Session not loaded")
      return { location: session.location }
    }
    let active: string | undefined
    let disposed = false
    async function showPending() {
      const route = ctx.ui.router.current()
      if (disposed || active || route.type !== "session" || !ctx.data.session.get(route.sessionID)) return
      const list = await client.list({ sessionID: route.sessionID }, atSession(route.sessionID))
      const current = ctx.ui.router.current()
      if (disposed || active || current.type !== "session" || current.sessionID !== route.sessionID) return
      const pending = list.reviews.find((review) => review.status === "pending")
      if (pending) open(pending)
    }
    const errors = (error: unknown) =>
      ctx.ui.toast.show({
        title: "XCoSpan",
        message: errorMessage(error),
        variant: "error",
      })
    const open = (review: Review) => {
      const route = ctx.ui.router.current()
      if (disposed || active || route.type !== "session" || route.sessionID !== review.sessionID) return
      const options = atSession(review.sessionID)
      active = review.id
      setReviewing(true)
      let settled = false
      ctx.ui.dialog.show(
        () => (
          <ReviewDialog
            initial={review}
            client={client}
            options={options}
            finished={() => {
              settled = true
            }}
          />
        ),
        () => {
          active = undefined
          setReviewing(false)
          if (disposed) return
          const closed = settled
            ? Promise.resolve()
            : client.cancel({ id: review.id, sessionID: review.sessionID }, options)
          void closed.then(showPending).catch(errors)
        },
      )
      ctx.ui.dialog.set({ size: "xlarge", centered: true })
    }
    async function reviewList() {
      const route = ctx.ui.router.current()
      if (route.type !== "session") throw new Error("Open a session first")
      const list = await client.list({ sessionID: route.sessionID }, atSession(route.sessionID))
      const pending = list.reviews.filter((review) => review.status === "pending")
      if (!pending.length) {
        ctx.ui.toast.show({ message: "No pending reviews" })
        return
      }
      const selected = await ctx.ui.dialog.select({
        title: "XCoSpan reviews",
        options: pending.map((review) => ({
          title: review.kind === "redaction" ? "Material review" : "Outbound review",
          description: `Revision ${review.revision}`,
          value: review.id,
        })),
      })
      if (selected)
        open(await client.get({ id: selected, sessionID: route.sessionID }, atSession(route.sessionID)))
    }
    async function runAction(cancel: boolean) {
      const route = ctx.ui.router.current()
      if (route.type !== "session") throw new Error("Open a session first")
      const list = await client.list({ sessionID: route.sessionID }, atSession(route.sessionID))
      const runs = cancel
        ? list.runs.filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
        : list.runs
      if (!runs.length) {
        ctx.ui.toast.show({ message: cancel ? "No cancellable cloud tasks" : "No cloud task records" })
        return
      }
      const id = await ctx.ui.dialog.select({
        title: cancel ? "Cancel cloud task" : "Recover cloud results",
        options: runs.map((run) => {
          const review = list.reviews.find((review) => review.id === run.reviewID)
          if (!review || !("goal" in review.candidate))
            throw new Error(`Cloud task has no outbound review: ${run.id}`)
          return {
            title: review.candidate.goal,
            description: runLabels[run.status],
            value: run.id,
          }
        }),
      })
      if (!id) return
      const run = await (cancel ? client.cancelRun : client.recover)(
        { id, sessionID: route.sessionID },
        atSession(route.sessionID),
      )
      ctx.ui.toast.show({ title: "Cloud task", message: runLabels[run.status] })
    }
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "xcospan.review",
          title: "XCoSpan: Review",
          palette: true,
          slash: { name: "xcospan-review" },
          run: () => reviewList().catch(errors),
        },
        {
          id: "xcospan.status",
          title: "XCoSpan: Status",
          palette: true,
          slash: { name: "xcospan-status" },
          run: async () => {
            try {
              const route = ctx.ui.router.current()
              const options =
                route.type === "session" ? atSession(route.sessionID) : { location: ctx.location }
              const result = await client.status({}, options)
              if (result.ready && ctx.ui.panel.open("xcospan.status")) return
              ctx.ui.toast.show({ message: result.message, variant: result.ready ? "success" : "warning" })
            } catch (error) {
              errors(error)
            }
          },
        },
        {
          id: "xcospan.cancel",
          title: "XCoSpan: Cancel cloud task",
          palette: true,
          slash: { name: "xcospan-cancel" },
          run: () => runAction(true).catch(errors),
        },
        {
          id: "xcospan.recover",
          title: "XCoSpan: Recover results",
          palette: true,
          slash: { name: "xcospan-recover" },
          run: () => runAction(false).catch(errors),
        },
      ],
    }))
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        ctx.ui.router.current()
        void management.firstRun()
        void showPending().catch(errors)
      })
      return dispose
    })
    // The 2.0.27 data store leaves metadata events to the consuming UI.
    const metadataUpdated = ctx.data.on("session.metadata.updated", (event) => {
      if (ctx.data.session.get(event.data.sessionID)?.agent !== PRIMARY_AGENT) return
      ctx.data.session.invalidate(event.data.sessionID)
      void ctx.data.session.sync(event.data.sessionID).catch(errors)
    })
    const reconnected = ctx.data.on("server.connected", () => {
      void showPending().catch(errors)
    })
    const unsubscribe = client.events.on("changed", (event) => {
      const route = ctx.ui.router.current()
      if (route.type === "session" && route.sessionID === event.data.sessionID)
        void showPending().catch(errors)
    })
    return () => {
      disposed = true
      if (active) ctx.ui.dialog.clear()
      dispose()
      unsubscribe()
      metadataUpdated()
      reconnected()
    }
  },
})
