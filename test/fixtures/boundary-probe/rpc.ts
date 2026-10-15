import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"

export const BoundaryProbe = Rpc.define({
  id: "boundary-probe",
  events: {},
  methods: {
    tools: { input: z.object({}), output: z.array(z.string()) },
  },
})
