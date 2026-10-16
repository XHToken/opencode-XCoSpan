import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { parseSettings } from "../../src/settings"
import { command, packageRegistry } from "../fixtures/registry"

test("native package commands preserve existing configuration through install, update and removal", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xcospan-install-")))
  const registry = await packageRegistry(root)
  const directory = join(root, "\u00e9 \u6750\u6599 # workspace")
  await mkdir(directory)
  const configDir = join(root, "config/opencode")
  await mkdir(configDir, { recursive: true })
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  await writeFile(
    join(configDir, "service.json"),
    JSON.stringify({ hostname: "127.0.0.1", port, password: "installation-test" }),
  )
  const configPath = join(configDir, "opencode.jsonc")
  const existing = {
    update: "disable",
    model: "existing/model",
    providers: {
      existing: { package: "@ai-sdk/openai-compatible", settings: { baseURL: "http://localhost:8000/v1" } },
    },
  }
  await writeFile(configPath, "// Existing user configuration\n" + JSON.stringify(existing, null, 2))
  const env = {
    ...process.env,
    ...registry.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }
  const cli = (...args: string[]) => {
    console.log("Native plugin command:", args.join(" "))
    return command([process.env.OPENCODE_BIN ?? "opencode", "plugin", ...args], env, directory)
  }
  try {
    await cli("add", registry.name)
    expect(registry.downloads()).toBeGreaterThan(0)
    const installed = await Bun.file(configPath).text()
    expect(installed).toContain("// Existing user configuration")
    expect(parseSettings(installed)).toEqual({ ...existing, plugins: [registry.name] })
    await cli("add", registry.name)
    expect(await Bun.file(configPath).text()).toBe(installed)
    await command([process.env.OPENCODE_BIN ?? "opencode", "service", "start"], env, directory)
    const service = await Bun.file(join(root, "state/opencode/service.json")).json()
    const client = OpenCode.make({
      baseUrl: service.url,
      headers: { Authorization: "Basic " + btoa("opencode:installation-test") },
    })
    // Service health precedes workspace plugin activation.
    const deadline = Date.now() + 20000
    while (true) {
      const plugin = (await client.plugin.list({ location: { directory } })).data.find(
        (item) => item.id === "xcospan",
      )
      if (plugin?.state.status === "failed") throw new Error(plugin.state.error)
      if (plugin?.state.status === "active") break
      if (Date.now() >= deadline) throw new Error("Installed plugin did not activate")
      await Bun.sleep(100)
    }
    expect(await cli("list")).toContain(registry.name)
    await cli("check", registry.name)
    await cli("update", registry.name)
    expect(parseSettings(await Bun.file(configPath).text())).toEqual({
      ...existing,
      plugins: [registry.name],
    })
    await cli("remove", registry.name)
    const removed = parseSettings(await Bun.file(configPath).text())
    expect(removed.model).toBe(existing.model)
    expect(removed.providers).toEqual(existing.providers)
    expect(removed.plugins ?? []).toEqual([])
  } finally {
    try {
      await command([process.env.OPENCODE_BIN ?? "opencode", "service", "stop"], env, directory)
    } finally {
      registry.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}, 300000)
