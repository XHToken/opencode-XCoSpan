import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { BoundaryProbe } from "./rpc"

// A working local extension whose execution can be counted outside the model protocol.
export default Plugin.define({
  id: "boundary-probe",
  async setup(ctx) {
    await ctx.rpc.register(BoundaryProbe, {
      tools: async () =>
        (await ctx.tool.list()).map((tool) =>
          tool.options?.namespace ? `${tool.options.namespace}_${tool.name}` : tool.name,
        ),
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "fixture_private",
        description: "Read the local fixture data",
        options: { codemode: false },
        input: z.object({}),
        async execute() {
          const response = await fetch(String(ctx.options.url))
          if (!response.ok) throw new Error("Boundary probe failed")
          return { content: await response.text() }
        },
      })
    })
  },
})
