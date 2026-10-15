import { Plugin } from "@opencode/plugin"

// The fixture holds a completed cloud result before its parent tool is committed.
export default Plugin.define({
  id: "delivery-barrier",
  async setup(ctx) {
    await ctx.session.hook("context", async (event) => {
      if (
        event.agent === "xcospan-cloud-worker" &&
        event.messages.some((message) =>
          message.content.some((part) => part.type === "text" && part.text.includes("CLOUD_CONTEXT_FAILURE")),
        )
      )
        throw new Error("Cloud context rejected fixture")
    })
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "cloud_delegate" || event.status !== "completed") return
      const response = await fetch(String(ctx.options.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID: event.sessionID }),
      })
      if (!response.ok) throw new Error("Delivery barrier failed")
    })
  },
})
