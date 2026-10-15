import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { editSettings, parseSettings } from "../src/settings"

/** Register a built source checkout; published packages use OpenCode's plugin add command. */
export async function registerSource(source: string, directory: string) {
  const target = await realpath(source)
  await stat(join(target, "dist/tui.js"))
  await mkdir(directory, { recursive: true })
  const paths = ["opencode.jsonc", "opencode.json"].map((name) => join(directory, name))
  const path =
    (await Promise.all(paths.map(async (path) => ((await Bun.file(path).exists()) ? path : undefined)))).find(
      Boolean,
    ) ?? paths[0]!
  const exists = await Bun.file(path).exists()
  const text = exists ? await readFile(path, "utf8") : "{}\n"
  const config = parseSettings(text)
  const entries = config.plugins ?? []
  if (!Array.isArray(entries)) throw new Error("OpenCode plugins must be an array")
  const installed = entries.some((item) => {
    const spec = typeof item === "string" ? item : item?.package
    if (typeof spec !== "string") throw new Error("Invalid OpenCode plugin entry")
    const local = spec.startsWith("file://") ? fileURLToPath(spec) : resolve(dirname(path), spec)
    return local === target
  })
  if (installed) return path
  const next = config.plugins
    ? editSettings(text, ["plugins", entries.length], target)
    : editSettings(text, ["plugins"], [target])
  const temporary = path + "." + crypto.randomUUID() + ".tmp"
  await writeFile(temporary, next, { mode: exists ? (await stat(path)).mode : 0o600, flag: "wx" })
  await rename(temporary, path)
  return path
}

if (import.meta.main) {
  const source = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."))
  const config = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  const path = await registerSource(source, config)
  console.log("XCoSpan registered in " + path)
  console.log("Open your workspace with opencode, then run /xcospan to choose models and start.")
}
