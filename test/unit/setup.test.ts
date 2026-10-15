import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerSource } from "../../scripts/setup"
import { parseSettings } from "../../src/settings"

test("source setup preserves existing JSONC, permissions and plugin options on repeated installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "xcospan-setup-"))
  try {
    const source = join(root, "source")
    const config = join(root, "config")
    await mkdir(join(source, "dist"), { recursive: true })
    await mkdir(config)
    await writeFile(join(source, "dist/tui.js"), "export {}")
    const path = join(config, "opencode.jsonc")
    await writeFile(
      path,
      '// account settings\n{"plugins":[/* keep */{"package":"other","options":{"enabled":false}}],"model":"provider/model"}',
      { mode: 0o600 },
    )
    expect(await registerSource(source, config)).toBe(path)
    const installed = await readFile(path, "utf8")
    expect(installed).toContain("/* keep */")
    expect(installed).toContain("// account settings")
    expect(parseSettings(installed).model).toBe("provider/model")
    expect(parseSettings(installed).plugins[0]).toEqual({ package: "other", options: { enabled: false } })
    expect(parseSettings(installed).plugins).toHaveLength(2)
    await registerSource(source, config)
    expect(await readFile(path, "utf8")).toBe(installed)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await writeFile(path, '{"plugins":')
    await expect(registerSource(source, config)).rejects.toThrow("not valid JSON")
    expect(await readFile(path, "utf8")).toBe('{"plugins":')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
