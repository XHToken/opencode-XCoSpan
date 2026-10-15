import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/tui/index.tsx"],
  naming: "tui.js",
  outdir: "./dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solid],
})
if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
