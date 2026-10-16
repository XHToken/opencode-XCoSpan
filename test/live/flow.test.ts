import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, realpath, cp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { OpenCode } from "@opencode/client"
import { XCoSpan } from "../../src/rpc"
import { Task } from "../../src/types"
import { stopHostProcess } from "../fixtures/process"
import { terminal } from "../integration/terminal"
import { liveModels } from "./config"
import { command, packageRegistry } from "../fixtures/registry"
import { parseSettings } from "../../src/settings"

// These tests incur real provider usage and send only synthetic test materials.
const records: { role: "local" | "cloud"; endpoint: string; body: unknown }[] = []
let directory: string
let host: ReturnType<typeof Bun.spawn>
let proxy: ReturnType<typeof Bun.serve>
let client: ReturnType<typeof OpenCode.make>
let logs = ""
let hostURL: string
let env: Record<string, string | undefined>
const liveRoot = resolve(import.meta.dir, "../../.local/live")
let artifactRoot: string
let models: ReturnType<typeof liveModels>
let deliveryGate: Promise<void> | undefined
let releaseDelivery: (() => void) | undefined
let heldSession: string | undefined
let registry: Awaited<ReturnType<typeof packageRegistry>> | undefined

async function until<T>(fn: () => Promise<T | undefined>, name: string, timeout = 1800000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value !== undefined) return value
    await Bun.sleep(200)
  }
  throw new Error(`Timeout ${name}; ${logs.slice(-3000)}`)
}

beforeAll(async () => {
  if (!process.env.XCOSPAN_LIVE_CONFIG)
    throw new Error("Set XCOSPAN_LIVE_CONFIG to a local model configuration file")
  models = liveModels(await Bun.file(process.env.XCOSPAN_LIVE_CONFIG).json())
  await mkdir(liveRoot, { recursive: true })
  const root = await realpath(await mkdtemp(join(liveRoot, "run-")))
  artifactRoot = root
  directory = join(root, "\u00e9 \u6750\u6599 # workspace")
  await mkdir(directory)
  await cp(resolve(import.meta.dir, "../fixtures/materials"), directory, { recursive: true })
  await writeFile(
    join(directory, "customers.csv"),
    "Customer,Contact,Phone,Revenue 2025,Revenue 2026\nStarport Manufacturing,Alex Chen,13800138000,120,168\nRiverbend Trading,Jordan Zhao,13900139000,80,76\n",
  )
  await writeFile(
    join(directory, "AGENTS.md"),
    "Private workspace audit marker: PRIVATE_WORKSPACE_SENTINEL. This marker is unrelated to the task and must not be shared.",
  )
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === "/delivery") {
        if (deliveryGate) {
          heldSession = ((await request.json()) as { sessionID: string }).sessionID
          await deliveryGate
        }
        return new Response("released")
      }
      const role = pathname.startsWith("/local/")
        ? "local"
        : pathname.startsWith("/cloud/")
          ? "cloud"
          : undefined
      if (!role) return new Response("Unknown role", { status: 404 })
      const body = await request.text()
      const payload = JSON.parse(body)
      const endpoint = pathname.slice(role.length + 1)
      const requestID = records.push({ role, endpoint, body: payload })
      await writeFile(join(artifactRoot, "requests.json"), JSON.stringify(records, null, 2))
      console.log(
        "Model request",
        role,
        endpoint,
        payload.model,
        "input length",
        payload.messages?.length ?? payload.input?.length ?? 0,
        "tools",
        payload.tools?.length ?? 0,
      )
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      let response: Response
      try {
        response = await fetch(models[role].baseURL + endpoint + new URL(request.url).search, {
          method: "POST",
          headers,
          body,
          signal: request.signal,
        })
      } catch (error) {
        const failure = {
          requestID,
          role,
          endpoint,
          aborted: request.signal.aborted,
          message: error instanceof Error ? error.message : String(error),
        }
        await writeFile(
          join(artifactRoot, `transport-${requestID}-${role}.json`),
          JSON.stringify(failure, null, 2),
        )
        console.error("Provider transport error", failure)
        return Response.json(
          { error: { type: "upstream_transport_error", message: failure.message } },
          { status: 502 },
        )
      }
      if (!response.ok) console.error("Provider HTTP error", role, response.status)
      const writer = Bun.file(join(artifactRoot, `response-${requestID}-${role}.sse`)).writer()
      const stream = response.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            writer.write(chunk)
            await writer.flush()
            controller.enqueue(chunk)
          },
          async flush() {
            await writer.end()
          },
        }),
      )
      return new Response(stream, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      })
    },
  })
  const config = {
    update: "disable",
    model: "local/" + models.local.id,
    websearch: models.websearch,
    plugins: [
      {
        package: resolve(import.meta.dir, "../fixtures/delivery-barrier"),
        options: { url: `${proxy.url}delivery` },
      },
      {
        package: process.env.XCOSPAN_PACKAGE ?? resolve(import.meta.dir, "../.."),
        options: {
          localModel: { providerID: "local", id: models.local.id },
          cloudModel: { providerID: "cloud", id: models.cloud.id },
          timeoutMs: 1800000,
        },
      },
    ],
    providers: {
      local: models.local.provider(`${proxy.url}local`),
      cloud: models.cloud.provider(`${proxy.url}cloud`),
    },
  }
  await writeFile(join(directory, "opencode.json"), JSON.stringify(config, null, 2))
  env = {
    ...process.env,
    OPENCODE_PASSWORD: "live-test-local",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }
  await mkdir(join(root, "config/opencode"), { recursive: true })
  await writeFile(join(root, "config/opencode/service.json"), JSON.stringify({ password: "live-test-local" }))
  await startHost()
  console.log("Live evidence directory:", root)
}, 30000)

async function startHost(port = 0) {
  logs = ""
  host = Bun.spawn(
    [
      process.env.OPENCODE_BIN ?? "opencode",
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      "--print-logs",
      "--log-level",
      "debug",
    ],
    { cwd: directory, env, stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" },
  )
  for (const stream of [host.stdout, host.stderr])
    void (async () => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) logs += new TextDecoder().decode(chunk)
    })()
  hostURL = await until(
    async () => {
      if (host.exitCode !== null || host.signalCode !== null)
        throw new Error(`Host exited during startup (${host.exitCode ?? host.signalCode}):\n${logs}`)
      return logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    },
    "host startup",
    10000,
  )
  client = OpenCode.make({
    baseUrl: hostURL,
    headers: { Authorization: `Basic ${btoa("opencode:live-test-local")}` },
    fetch: Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args)
        if (response.status >= 500) {
          let detail = await response.clone().text()
          for (const model of [models.local, models.cloud]) {
            const key = Reflect.get(model.provider("").settings, "apiKey")
            if (typeof key === "string" && key) detail = detail.replaceAll(key, "[redacted]")
          }
          throw new Error("Host HTTP " + response.status + ": " + detail)
        }
        return response
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const plugin = await until(
    async () => {
      try {
        return (await client.plugin.list({ location: { directory } })).data.find(
          (item) => item.id === "xcospan",
        )
      } catch (cause) {
        let detail = logs
        for (const model of [models.local, models.cloud]) {
          const key = Reflect.get(model.provider("").settings, "apiKey")
          if (typeof key === "string" && key) detail = detail.replaceAll(key, "[redacted]")
        }
        throw new Error("Plugin activation failed:\n" + detail, { cause })
      }
    },
    "plugin activation",
    10000,
  )
  expect(plugin.state).toEqual({ status: "active" })
}

async function stopHost() {
  if (!host) return
  await stopHostProcess(host)
}

afterAll(async () => {
  await stopHost()
  proxy?.stop(true)
  registry?.close()
  if (artifactRoot) {
    await writeFile(join(artifactRoot, "requests.json"), JSON.stringify(records, null, 2))
    await writeFile(join(artifactRoot, "host.log"), logs)
  }
})

test("real quick start and four consecutive tasks use one native TUI session", async () => {
  await stopHost()
  const options = { location: { directory } }
  const path = join(directory, "opencode.json")
  const config = await Bun.file(path).json()
  config.plugins.splice(1, 1)
  await writeFile(path, JSON.stringify(config, null, 2))
  const published = process.env.XCOSPAN_INSTALL_SPEC || undefined
  if (!published) {
    registry = await packageRegistry(artifactRoot)
    env = { ...env, ...registry.env }
  }
  const packageSpec = published ?? registry!.name
  const globalPath = join(env.XDG_CONFIG_HOME!, "opencode/opencode.jsonc")
  const existing = { model: config.model, providers: config.providers }
  await writeFile(globalPath, "// Existing user models\n" + JSON.stringify(existing, null, 2))
  delete config.model
  delete config.providers
  await writeFile(path, JSON.stringify(config, null, 2))
  const installed = await command(
    [process.env.OPENCODE_BIN ?? "opencode", "plugin", "add", packageSpec],
    env,
    directory,
  )
  if (registry) expect(registry.downloads()).toBeGreaterThan(0)
  const registered = await Bun.file(globalPath).text()
  expect(registered).toContain("// Existing user models")
  expect(parseSettings(registered)).toEqual({ ...existing, plugins: [packageSpec] })
  await writeFile(join(artifactRoot, "quick-start-install.txt"), installed)
  await startHost()
  const rpc = client.rpc(XCoSpan)
  await until(
    async () => (!(await rpc.status({}, options)).ready ? true : undefined),
    "unconfigured plugin",
    15000,
  )
  const session = await client.session.create({
    ...options,
    agent: "build",
    model: { providerID: "local", id: models.local.id },
  })
  const tui = terminal(
    [process.env.OPENCODE_BIN ?? "opencode", "--server", hostURL, "--session", session.id, directory],
    env,
    120,
    40,
  )
  async function screen(text: string) {
    await until(async () => (tui.screen().includes(text) ? true : undefined), text, 20000)
  }
  async function pick(text: string) {
    await Bun.sleep(250)
    tui.write(text)
    await Bun.sleep(250)
    tui.write("\r")
  }
  try {
    await screen("Build ·")
    tui.write("/xcospan")
    await screen("XCoSpan: Setup and management")
    tui.write("\r")
    await screen("Configure models")
    await pick("Configure models")
    await screen("Choose the local model")
    await pick("local/" + models.local.id)
    await screen("Choose the cloud model")
    await pick("cloud/" + models.cloud.id)
    await screen("Review model configuration")
    await pick("Test connection and tool calling")
    await until(async () => {
      const before = await rpc.settings({ paths: [] }, options)
      return records.some((r) => JSON.stringify(r.body).includes("xcospan_model_probe")) &&
        before.active === 0 &&
        tui.screen().includes("Model check results")
        ? true
        : undefined
    }, "real model compatibility probes")
    expect(
      records.filter((r) => JSON.stringify(r.body).includes("xcospan_model_probe")).length,
    ).toBeGreaterThanOrEqual(4)
    expect(tui.screen().match(/Connection and tool calling passed/g)).toHaveLength(2)
    tui.write("\r")
    await screen("Review model configuration")
    await pick("Save and start")
    await screen("Save model roles")
    tui.write("\r")
    await screen("Default agent for new sessions")
    await pick("Keep the current default")
    await screen("XCoSpan started")
    expect((await client.session.get({ sessionID: session.id })).agent).toBe("xcospan")
    expect((await rpc.status({}, options)).ready).toBe(true)
    tui.resize(150, 50)
    const steps = [
      {
        name: "local-first",
        text: "Calculate 17 times 23 locally. Return only the result.",
        cloud: false,
        answer: "391",
      },
      {
        name: "cloud-text",
        text: "Our internal project codename is JuniperVault and its lead contact is Mira Vale, mira.vale@example.test. Keep these identities private. Use cloud collaboration to compare SQLite WAL and PostgreSQL for a small-team collaboration product: concurrent writes and backup operations. Research official sources, cite them, and recommend when to choose each in under 150 words.",
        cloud: true,
      },
      {
        name: "cloud-file",
        text: "Read customers.csv and use cloud collaboration to assess customer revenue changes and concentration risk. Keep customer names, contacts and phone numbers private; preserve the figures needed for analysis. Give three recommendations in under 150 words.",
        cloud: true,
      },
      {
        name: "local-last",
        text: "Calculate 29 times 31 locally. Return only the result.",
        cloud: false,
        answer: "899",
      },
    ]
    const reviewedTable = [
      "User-reviewed customer revenue table. Identities and contact details are withheld.",
      "The user authorizes these figures for the requested revenue and concentration analysis.",
      "Customer,Revenue 2025,Revenue 2026",
      "Customer A,120,168",
      "Customer B,80,76",
      "The dataset contains two customers. Units are unspecified.",
    ].join("\n")
    const evidence: unknown[] = []
    for (const step of steps) {
      const before = await rpc.list({ sessionID: session.id }, options)
      const previousIdle = (await client.session.get({ sessionID: session.id })).time.idle
      const requestStart = records.length
      const started = Date.now()
      const reviewed = new Set<string>()
      const snapshots = new Set<string>()
      await screen("XCoSpan")
      tui.write("\x1b[200~" + step.text + "\x1b[201~")
      await until(
        async () =>
          tui.screen().includes(step.text.slice(0, 20)) || tui.screen().includes("[Pasted")
            ? true
            : undefined,
        "pasted task",
        15000,
      )
      tui.write("\r")
      await until(
        async () => {
          const history = await client.session.context({ sessionID: session.id })
          return JSON.stringify(history).includes(step.text) ? true : undefined
        },
        "TUI submitted " + step.name,
        20000,
      )
      const state = await until(async () => {
        const view = tui.screen()
        for (const label of [
          "Routing this request",
          "Material review",
          "Outbound review",
          "Latest progress",
          "Results returned",
        ]) {
          if (view.includes(label) && !snapshots.has(label)) {
            snapshots.add(label)
            await writeFile(join(artifactRoot, step.name + "-" + snapshots.size + ".txt"), view)
          }
        }
        const state = await rpc.list({ sessionID: session.id }, options)
        for (const review of state.reviews.filter(
          (item) => item.status === "pending" && !reviewed.has(item.id),
        )) {
          expect(step.cloud).toBe(true)
          const label = review.kind === "redaction" ? "Material review" : "Outbound review"
          await screen(label + " · revision")
          await screen("Ctrl+A Approve")
          expect(records.slice(requestStart).filter((item) => item.role === "cloud")).toHaveLength(0)
          if (review.kind === "redaction" && step.name === "cloud-file") {
            // Exercise the user's substantive review: preserve needed figures and remove identities.
            // This edits an approval candidate, never the redaction algorithm or a sent payload.
            expect(JSON.stringify(review.original)).toContain("168")
            tui.write("\x05")
            await screen("Redacted content · Tab")
            tui.write("\x1b[97;9u")
            tui.write("\x1b[200~" + reviewedTable + "\x1b[201~")
            await screen("User-reviewed customer revenue table")
            tui.write("\x13")
            await until(
              async () => {
                const saved = await rpc.get({ id: review.id, sessionID: session.id }, options)
                return saved.revision === review.revision + 1 &&
                  "type" in saved.candidate &&
                  saved.candidate.type === "text" &&
                  saved.candidate.text === reviewedTable
                  ? true
                  : undefined
              },
              "edited material revision",
              15000,
            )
            await screen("Ctrl+A Approve")
          }
          if (review.kind === "outbound") {
            tui.write("\x05")
            await screen("Task goal · Tab")
            tui.write("\x01Review note: Keep the final response concise. ")
            await screen("Review note")
            tui.write("\x13")
            await until(
              async () => {
                const saved = await rpc.get({ id: review.id, sessionID: session.id }, options)
                return saved.revision === review.revision + 1 ? true : undefined
              },
              "edited outbound revision",
              15000,
            )
            await screen("Ctrl+A Approve")
          }
          await writeFile(join(artifactRoot, step.name + "-review-" + review.id + ".txt"), tui.screen())
          tui.write("\x01")
          await until(
            async () =>
              (await rpc.get({ id: review.id, sessionID: session.id }, options)).status === "approved"
                ? true
                : undefined,
            "TUI approved " + label,
            15000,
          )
          reviewed.add(review.id)
        }
        const info = await client.session.get({ sessionID: session.id })
        if (info.time.idle === undefined || info.time.idle === previousIdle) return undefined
        if (info.outcome === "failed" || info.outcome === "interrupted")
          throw new Error(step.name + ": " + info.outcome)
        return info.outcome === "succeeded" ? state : undefined
      }, step.name)
      const history = await client.session.context({ sessionID: session.id })
      const requests = records.slice(requestStart)
      const cloud = requests.filter((item) => item.role === "cloud")
      const reviews = state.reviews.filter((item) => !before.reviews.some((old) => old.id === item.id))
      const runs = state.runs.filter((item) => !before.runs.some((old) => old.id === item.id))
      if (step.cloud) {
        expect(cloud.length).toBeGreaterThan(0)
        expect(reviews.some((item) => item.kind === "redaction" && item.status === "approved")).toBe(true)
        expect(
          reviews.some((item) => item.kind === "outbound" && item.status === "approved" && item.revision > 1),
        ).toBe(true)
        expect(runs.length).toBeGreaterThan(0)
        expect(runs.every((item) => item.status === "completed")).toBe(true)
        if (step.name === "cloud-file") {
          expect(reviews.some((item) => item.kind === "redaction" && item.revision > 1)).toBe(true)
          expect(JSON.stringify(cloud)).toContain(JSON.stringify(reviewedTable).slice(1, -1))
        }
        for (const run of runs) {
          const call = history
            .flatMap((item) => (item.type === "assistant" ? item.content : []))
            .find((part) => part.type === "tool" && part.id === run.callID)
          expect(call?.type === "tool" && call.state.status).toBe("completed")
          expect(JSON.stringify(history)).toContain(JSON.stringify(run.result).slice(1, -1))
        }
        for (const secret of [
          "JuniperVault",
          "Mira Vale",
          "mira.vale@example.test",
          "Starport Manufacturing",
          "Riverbend Trading",
          "Alex Chen",
          "Jordan Zhao",
          "13800138000",
          "13900139000",
          "PRIVATE_WORKSPACE_SENTINEL",
          directory,
        ])
          expect(JSON.stringify(cloud)).not.toContain(secret)
      } else {
        expect(cloud).toHaveLength(0)
        expect(reviews).toHaveLength(0)
        expect(runs).toHaveLength(0)
        expect(JSON.stringify(history.findLast((item) => item.type === "assistant"))).toContain(step.answer!)
      }
      evidence.push({
        step: step.name,
        sessionID: session.id,
        elapsedMs: Date.now() - started,
        requests: { local: requests.length - cloud.length, cloud: cloud.length },
        reviews,
        runs,
        observed: [...snapshots],
      })
      await writeFile(join(artifactRoot, "journey.json"), JSON.stringify(evidence, null, 2))
      await writeFile(join(artifactRoot, step.name + "-final.txt"), tui.screen())
      console.log("Journey completed", step.name, "session", session.id, "cloud requests", cloud.length)
    }
    await writeFile(
      join(artifactRoot, "journey-session.json"),
      JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
    )
  } finally {
    await writeFile(join(artifactRoot, "onboarding-tui.txt"), tui.screen())
    await tui.close()
  }
}, 1860000)

test("real models consume a recovered cloud result after host restart", async () => {
  const start = records.length
  const options = { location: { directory } }
  const session = await client.session.create({ ...options, agent: "xcospan" })
  const rpc = client.rpc(XCoSpan)
  deliveryGate = new Promise<void>((resolve) => {
    releaseDelivery = resolve
  })
  heldSession = undefined
  let tui: ReturnType<typeof terminal> | undefined
  try {
    await client.session.prompt({
      sessionID: session.id,
      text: "I am Alex Chen from Starport Manufacturing. Use cloud collaboration to analyze inventory replenishment strategies for manufacturers. Compare the suitability and risks of fixed-quantity, periodic, and just-in-time replenishment, and give three concise recommendations. Redact my identity first.",
    })
    const state = await until(async () => {
      const state = await rpc.list({ sessionID: session.id }, options)
      await writeFile(join(artifactRoot, "recovery-state.json"), JSON.stringify(state, null, 2))
      for (const review of state.reviews.filter((item) => item.status === "pending")) {
        console.log("Recovery review", review.kind, review.revision)
        expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
        const candidate =
          review.kind === "redaction"
            ? {
                type: "text",
                text: "A manufacturer needs to compare the suitability and risks of fixed-quantity, periodic, and just-in-time replenishment. Provide three concise recommendations.",
              }
            : {
                ...Task.parse(review.candidate),
                goal: "Analyze the suitability and risks of inventory replenishment strategies for manufacturers.",
                context: "Compare fixed-quantity, periodic, and just-in-time replenishment.",
                expectedOutput: "Give three concise recommendations and the business conditions for each.",
              }
        const edited = await rpc.edit(
          {
            id: review.id,
            sessionID: session.id,
            revision: review.revision,
            candidate,
          },
          options,
        )
        for (const secret of ["Starport Manufacturing", "Alex Chen", "PRIVATE_WORKSPACE_SENTINEL", directory])
          expect(JSON.stringify(edited.candidate)).not.toContain(secret)
        await rpc.approve({ id: edited.id, sessionID: session.id, revision: edited.revision }, options)
      }
      const status = await client.session.get({ sessionID: session.id })
      if (status.outcome === "failed" || status.outcome === "interrupted")
        throw new Error(`Session ${status.outcome} before recovery checkpoint`)
      return heldSession === session.id ? await rpc.list({ sessionID: session.id }, options) : undefined
    }, "completed real cloud result before delivery")
    const run = state.runs[0]!
    expect(run.status).toBe("completed")
    expect(run.result!.length).toBeGreaterThan(50)
    expect((await client.session.get({ sessionID: run.childID })).outcome).toBe("succeeded")
    const cloudCount = records.filter((item) => item.role === "cloud").length
    const port = Number(new URL(hostURL).port)
    await writeFile(join(artifactRoot, "host-before-crash.log"), logs)
    await stopHostProcess(host, "SIGKILL")
    releaseDelivery!()
    deliveryGate = undefined
    const resumeStart = records.length
    await startHost(port)
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(1800000) })
    tui = terminal(
      [process.env.OPENCODE_BIN ?? "opencode", "--server", hostURL, "--session", session.id, directory],
      env,
    )
    await until(async () => (tui!.screen().includes("XCoSpan") ? true : undefined), "recovery TUI", 15000)
    tui.write("/xcospan-recover")
    await until(
      async () => (tui!.screen().includes("XCoSpan: Recover results") ? true : undefined),
      "recovery command",
      15000,
    )
    tui.write("\r")
    await until(
      async () => (tui!.screen().includes("Recover cloud results") ? true : undefined),
      "recovery selection",
      15000,
    )
    tui.write("\r")
    const restored = client.rpc(XCoSpan)
    await until(
      async () =>
        (await restored.list({ sessionID: session.id }, options)).runs[0]?.delivered ? true : undefined,
      "native recovery submission",
      15000,
    )
    await restored.recover({ id: run.id, sessionID: session.id }, options)
    expect(await client.session.inbox.list({ sessionID: session.id })).toHaveLength(0)
    const history = await client.session.context({ sessionID: session.id })
    expect(
      history.filter((item) => item.type === "synthetic" && item.metadata?.xcospanRecovery === run.id),
    ).toHaveLength(1)
    await writeFile(join(artifactRoot, "recovery-session.json"), JSON.stringify(history, null, 2))
    const result = await restored.list({ sessionID: session.id }, options)
    await writeFile(join(artifactRoot, "recovery-state.json"), JSON.stringify(result, null, 2))
    expect((await client.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]?.childID).toBe(run.childID)
    expect(result.runs[0]?.result).toBe(run.result)
    expect(records.filter((item) => item.role === "cloud")).toHaveLength(cloudCount)
    const resumed = records.slice(resumeStart).filter((item) => item.role === "local")
    expect(
      resumed.some((item) => JSON.stringify(item.body).includes(JSON.stringify(run.result!).slice(1, -1))),
    ).toBe(true)
    const last = history.findLast((message) => message.type === "assistant")
    const text =
      last?.type === "assistant"
        ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        : ""
    expect(text.length).toBeGreaterThan(50)
    for (const request of records.slice(start)) {
      if (request.role === "local") expect(request.body).toMatchObject(models[request.role].expectedRequest)
      else {
        expect(request.body).toMatchObject(models[request.role].expectedRequest)
        for (const secret of ["Starport Manufacturing", "Alex Chen", "PRIVATE_WORKSPACE_SENTINEL", directory])
          expect(JSON.stringify(request.body)).not.toContain(secret)
      }
    }
  } finally {
    releaseDelivery!()
    deliveryGate = undefined
    if (tui) {
      await writeFile(join(artifactRoot, "recovery-tui.txt"), tui.screen())
      await tui.close()
    }
    await writeFile(
      join(artifactRoot, "recovery-session.json"),
      JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
    )
    await client.session.interrupt({ sessionID: session.id, resume: false })
  }
}, 1860000)

test.each(["redaction", "outbound", "cloud"] as const)(
  "real models respect cancellation during %s",
  async (stage) => {
    const start = records.length
    const options = { location: { directory } }
    const session = await client.session.create({ ...options, agent: "xcospan" })
    const rpc = client.rpc(XCoSpan)
    let cancelled = false
    try {
      await client.session.prompt({
        sessionID: session.id,
        text: "Use cloud collaboration to research public sources and compare fixed-quantity, periodic, and just-in-time replenishment strategies for manufacturers. Explain their applicability and risks.",
      })
      const result = await until(async () => {
        const state = await rpc.list({ sessionID: session.id }, options)
        if (cancelled && state.reviews.some((item) => item.status === "pending"))
          throw new Error("A new review appeared after user cancellation")
        for (const review of state.reviews.filter((item) => item.status === "pending")) {
          expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
          if (review.kind === stage) {
            await rpc.cancel({ id: review.id, sessionID: session.id }, options)
            cancelled = true
          } else {
            await rpc.approve({ id: review.id, sessionID: session.id, revision: review.revision }, options)
          }
        }
        if (stage === "cloud" && !cancelled && records.slice(start).some((item) => item.role === "cloud")) {
          const run = state.runs.find((item) => item.status === "running")
          if (!run) throw new Error("Expected an active child when cancelling its model request")
          const stopped = await rpc.cancelRun({ id: run.id, sessionID: session.id }, options)
          expect(stopped.status).toBe("cancelled")
          expect((await client.session.get({ sessionID: run.childID })).outcome).toBe("interrupted")
          cancelled = true
        }
        if (cancelled) {
          const history = await client.session.context({ sessionID: session.id })
          const pendingQuestion = history
            .flatMap((message) => (message.type === "assistant" ? message.content : []))
            .some(
              (part) =>
                part.type === "tool" &&
                part.name === "question" &&
                (part.state.status === "streaming" || part.state.status === "running"),
            )
          if (pendingQuestion) throw new Error("Cancellation must finish without another user question")
        }
        const status = await client.session.get({ sessionID: session.id })
        if (status.outcome) {
          expect(cancelled).toBe(true)
          return await rpc.list({ sessionID: session.id }, options)
        }
        return undefined
      }, `real cancellation during ${stage}`)
      expect(result.reviews.filter((item) => item.status === "pending")).toHaveLength(0)
      if (stage === "cloud") {
        expect(result.runs).toHaveLength(1)
        expect(result.runs[0]?.status).toBe("cancelled")
        expect(result.runs[0]?.result).toBeUndefined()
        const history = await client.session.context({ sessionID: session.id })
        expect(
          history
            .flatMap((item) => (item.type === "assistant" ? item.content : []))
            .filter(
              (part) =>
                part.type === "tool" && part.name === "cloud_delegate" && part.state.status === "completed",
            ),
        ).toHaveLength(0)
      } else {
        expect(result.runs).toHaveLength(0)
        expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
        expect(result.reviews.some((item) => item.kind === stage && item.status === "cancelled")).toBe(true)
      }
    } finally {
      await client.session.interrupt({ sessionID: session.id, resume: false })
      await writeFile(
        join(artifactRoot, `cancel-${stage}-session.json`),
        JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
      )
      await writeFile(
        join(artifactRoot, `cancel-${stage}-state.json`),
        JSON.stringify(await rpc.list({ sessionID: session.id }, options), null, 2),
      )
    }
  },
  1860000,
)

test("the local model performs a task in the actual OpenCode loop", async () => {
  const start = records.length
  const session = await client.session.create({ location: { directory }, agent: "xcospan" })
  await client.session.prompt({
    sessionID: session.id,
    text: "Calculate 137 times 29 locally and return the exact result.",
  })
  await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(1800000) })
  const history = await client.session.context({ sessionID: session.id })
  await writeFile(join(artifactRoot, "local-session.json"), JSON.stringify(history, null, 2))
  expect((await client.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
  expect(JSON.stringify(history)).toContain("3973")
  expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
}, 1860000)

test("real models complete reviewed text collaboration", async () => {
  const start = records.length
  const session = await client.session.create({ location: { directory }, agent: "xcospan" })
  const rpc = client.rpc(XCoSpan)
  const options = { location: { directory } }
  await client.session.prompt({
    sessionID: session.id,
    text: "I am Alex Chen from Starport Manufacturing, phone 13800138000. Use cloud collaboration to research public sources and analyze how manufacturers should choose inventory replenishment strategies. Compare their applicability and risks and give concise recommendations. Redact my identity and contact details first.",
  })
  const approved: string[] = []
  const result = await until(async () => {
    const state = await rpc.list({ sessionID: session.id }, options)
    await writeFile(join(artifactRoot, "text-state.json"), JSON.stringify(state, null, 2))
    for (const review of state.reviews.filter((item) => item.status === "pending")) {
      if (approved.includes(review.id)) continue
      console.log("Review", review.kind, review.revision)
      if (review.kind === "outbound") {
        const candidate = Task.parse(review.candidate)
        // Simulate the user reviewing all outbound fields, including model-composed text.
        // Approval sends the user's edited version of every outbound field.
        expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
        const reviewed = state.reviews.find((item) => item.kind === "redaction" && item.status === "approved")
        if (!reviewed) throw new Error("Expected approved redaction before outbound review")
        const edited = await rpc.edit(
          {
            id: review.id,
            sessionID: session.id,
            revision: review.revision,
            candidate: {
              ...candidate,
              goal: "Research public sources and analyze the applicability and risks of inventory replenishment strategies for manufacturers.",
              context: (reviewed.candidate as { text: string }).text,
              expectedOutput:
                "Give concise, sourced recommendations and finish with three actionable recommendations.",
            },
          },
          options,
        )
        await rpc.approve({ id: edited.id, sessionID: session.id, revision: edited.revision }, options)
      } else await rpc.approve({ id: review.id, sessionID: session.id, revision: review.revision }, options)
      approved.push(review.id)
    }
    const status = await client.session.get({ sessionID: session.id })
    if (status.outcome === "failed" || status.outcome === "interrupted") {
      await writeFile(
        join(artifactRoot, "failed-session.json"),
        JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
      )
      throw new Error(`Session ${status.outcome}; see failed-session.json`)
    }
    return status.outcome === "succeeded" ? state : undefined
  }, "reviewed text collaboration")
  const history = await client.session.context({ sessionID: session.id })
  await writeFile(join(artifactRoot, "text-session.json"), JSON.stringify(history, null, 2))
  expect(result.reviews.some((review) => review.kind === "redaction" && review.status === "approved")).toBe(
    true,
  )
  expect(result.runs.some((run) => run.status === "completed")).toBe(true)
  const cloudRequests = records.slice(start).filter((item) => item.role === "cloud")
  expect(cloudRequests.length).toBeGreaterThan(0)
  for (const request of cloudRequests)
    expect(request.body).toMatchObject(models[request.role].expectedRequest)
  for (const request of records.slice(start).filter((item) => item.role === "local"))
    expect(request.body).toMatchObject(models[request.role].expectedRequest)
  const outbound = JSON.stringify(cloudRequests)
  expect(outbound).toContain("three actionable recommendations")
  for (const secret of [
    "Starport Manufacturing",
    "Riverbend Trading",
    "Alex Chen",
    "Jordan Zhao",
    "13800138000",
    "13900139000",
    "PRIVATE_WORKSPACE_SENTINEL",
    directory,
  ])
    expect(outbound).not.toContain(secret)
}, 1860000)

test("real models use the materials Skill across document, slides and scanned image", async () => {
  const start = records.length
  const options = { location: { directory } }
  const session = await client.session.create({
    ...options,
    agent: "xcospan",
    permissions: ["read", "shell", "write", "skill"].map((action) => ({
      action,
      resource: "*",
      effect: "allow" as const,
    })),
  })
  const rpc = client.rpc(XCoSpan)
  try {
    await client.session.prompt({
      sessionID: session.id,
      text: "Use the xcospan-materials Skill to prepare inspection.doc, inspection.docx, deployment.pptx and shipping-scan.png. Identify each source's reference and key finding, including the scan's package weight. Use cloud collaboration to produce a concise evidence inventory and identify what these materials establish and what remains unverified. Include only relevant reviewed evidence.",
    })
    const state = await until(async () => {
      const current = await rpc.list({ sessionID: session.id }, options)
      for (const review of current.reviews.filter((item) => item.status === "pending")) {
        expect(records.slice(start).filter((item) => item.role === "cloud")).toHaveLength(0)
        const candidate = JSON.stringify(review.candidate)
        expect(candidate).not.toContain("PRIVATE_WORKSPACE_SENTINEL")
        expect(candidate).not.toContain(directory)
        await rpc.approve({ id: review.id, sessionID: session.id, revision: review.revision }, options)
      }
      const status = await client.session.get({ sessionID: session.id })
      if (status.outcome === "failed" || status.outcome === "interrupted")
        throw new Error("Materials session " + status.outcome)
      return status.outcome === "succeeded" ? current : undefined
    }, "unified materials collaboration")
    const history = await client.session.context({ sessionID: session.id })
    const completedTools = history
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter((part) => part.type === "tool" && part.state.status === "completed")
    expect(
      completedTools.some(
        (part) =>
          part.type === "tool" && part.name === "skill" && JSON.stringify(part).includes("xcospan-materials"),
      ),
    ).toBe(true)
    expect(JSON.stringify(completedTools)).toContain("extract.ts")
    const failures = history
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .filter(
        (part) =>
          part.type === "tool" &&
          part.state.status === "error" &&
          ["redact", "redact_image", "cloud_delegate"].includes(part.name),
      )
    expect(failures).toHaveLength(0)
    expect(state.runs.some((run) => run.status === "completed")).toBe(true)
    for (const kind of ["redaction", "outbound"])
      expect(state.reviews.some((review) => review.kind === kind && review.status === "approved")).toBe(true)
    const sent = JSON.stringify(records.slice(start).filter((item) => item.role === "cloud"))
    for (const fact of ["731", "842", "953", "42"]) expect(sent).toContain(fact)
    expect(sent).not.toContain("PRIVATE_WORKSPACE_SENTINEL")
    expect(sent).not.toContain(directory)
  } finally {
    await writeFile(
      join(artifactRoot, "materials-session.json"),
      JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
    )
    await writeFile(
      join(artifactRoot, "materials-state.json"),
      JSON.stringify(await rpc.list({ sessionID: session.id }, options), null, 2),
    )
    await client.session.interrupt({ sessionID: session.id, resume: false })
  }
}, 1860000)

test("real models extract PDF and Excel, combine materials and route a follow-up locally", async () => {
  const start = records.length
  const session = await client.session.create({
    location: { directory },
    agent: "xcospan",
    permissions: ["read", "shell", "write", "skill"].map((action) => ({
      action,
      resource: "*",
      effect: "allow" as const,
    })),
  })
  const rpc = client.rpc(XCoSpan)
  const options = { location: { directory } }
  console.log("Multifile session:", session.id)
  try {
    await client.session.prompt({
      sessionID: session.id,
      text: "Review the procurement plan using procurement-terms.pdf and every sheet in procurement-items.xlsx. Calculate the total price, payment installments, and funding gap. Use cloud collaboration to analyze payment, acceptance, delivery, and liability risks and propose amendments. Redact company names, personal names, and contact details first, preserving the clauses and calculation inputs. Give conclusions supported by the numbers.",
    })
    const result = await until(async () => {
      const state = await rpc.list({ sessionID: session.id }, options)
      await writeFile(join(artifactRoot, "multifile-state.json"), JSON.stringify(state, null, 2))
      for (const review of state.reviews.filter((item) => item.status === "pending")) {
        const candidate = review.candidate
        for (const secret of [
          "Starport Manufacturing",
          "Alex Chen",
          "Jordan Zhao",
          "13800138000",
          "13900139000",
        ])
          expect(JSON.stringify(candidate)).not.toContain(secret)
        const edited = await rpc.edit(
          {
            id: review.id,
            sessionID: session.id,
            revision: review.revision,
            candidate:
              review.kind === "outbound"
                ? {
                    ...Task.parse(candidate),
                    expectedOutput:
                      Task.parse(candidate).expectedOutput +
                      "\nReview note: Provide specific amounts for payment adjustments.",
                  }
                : {
                    ...candidate,
                    text:
                      (candidate as { text: string }).text +
                      "\nReview note: The figures and clauses have been checked.",
                  },
          },
          options,
        )
        await rpc.approve({ id: edited.id, sessionID: session.id, revision: edited.revision }, options)
        console.log("Approved multifile", review.kind, edited.revision)
      }
      const status = await client.session.get({ sessionID: session.id })
      if (status.outcome === "failed" || status.outcome === "interrupted")
        throw new Error(`Multifile session ${status.outcome}`)
      return status.outcome === "succeeded" ? state : undefined
    }, "PDF / Excel collaboration")
    const history = await client.session.context({ sessionID: session.id })
    expect(result.runs.some((run) => run.status === "completed")).toBe(true)
    for (const kind of ["redaction", "outbound"])
      expect(
        result.reviews.some(
          (review) => review.kind === kind && review.status === "approved" && review.revision > 1,
        ),
      ).toBe(true)
    const originals = JSON.stringify(
      result.reviews.filter((review) => review.kind === "redaction").map((review) => review.original),
    )
    for (const fact of ["82", "55000", "3600", "180000"])
      expect(originals.replaceAll(",", "")).toContain(fact)
    const outbound = JSON.stringify(records.slice(start).filter((item) => item.role === "cloud"))
    expect(outbound).toContain("specific amounts for payment adjustments")
    for (const secret of [
      "Starport Manufacturing",
      "Alex Chen",
      "Jordan Zhao",
      "13800138000",
      "13900139000",
      "PRIVATE_WORKSPACE_SENTINEL",
      directory,
    ])
      expect(outbound).not.toContain(secret)
    const finalText = history
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .replaceAll(",", "")
    expect(finalText).toMatch(/300200|30\.02/)
    expect(finalText).toMatch(/15130|1\.513/)
    const afterCloud = records.length
    const reviewsBefore = result.reviews.length
    await client.session.prompt({
      sessionID: session.id,
      text: "Thanks. Next, calculate 137 times 29 locally and return only the exact result.",
    })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(1800000) })
    expect((await client.session.get({ sessionID: session.id })).outcome).toBe("succeeded")
    expect(records.slice(afterCloud).filter((item) => item.role === "cloud")).toHaveLength(0)
    expect((await rpc.list({ sessionID: session.id }, options)).reviews).toHaveLength(reviewsBefore)
    const followup = await client.session.context({ sessionID: session.id })
    expect(JSON.stringify(followup)).toContain("3973")
    const lastUser = followup.findLast((message) => message.type === "user")
    expect((await client.session.get({ sessionID: session.id })).metadata?.xcospanRoute).toMatchObject({
      messageID: lastUser?.id,
      result: { cloud: false },
    })
    for (const request of records.slice(start)) {
      expect(request.body).toMatchObject(models[request.role].expectedRequest)
    }
  } finally {
    await writeFile(
      join(artifactRoot, "multifile-session.json"),
      JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
    )
    await writeFile(
      join(artifactRoot, "multifile-state.json"),
      JSON.stringify(await rpc.list({ sessionID: session.id }, options), null, 2),
    )
  }
}, 1860000)

test("real sidebar shows cloud research progress through both reviews and delivery", async () => {
  const session = await client.session.create({ location: { directory }, agent: "xcospan" })
  const rpc = client.rpc(XCoSpan)
  const options = { location: { directory } }
  const tui = terminal(
    [process.env.OPENCODE_BIN ?? "opencode", "--server", hostURL, "--session", session.id, directory],
    env,
    150,
    50,
  )
  const seen = new Set<string>()
  const approved = new Set<string>()
  const observed = [
    "Routing this request",
    "Cloud collaboration · Reasoning",
    "websearch",
    "webfetch",
    "Latest progress",
    "Results returned · 1 completed",
  ]
  try {
    await until(async () => (tui.screen().includes("XCoSpan") ? true : undefined), "sidebar startup", 15000)
    await client.session.prompt({
      sessionID: session.id,
      text: "Use cloud collaboration to research public sources and compare SQLite WAL and PostgreSQL for a small-team collaboration product: concurrent writes, operations, and backups. Cite official sources and recommend when to choose each, in under 500 words.",
    })
    const result = await until(async () => {
      const screen = tui.screen()
      for (const label of observed)
        if (screen.includes(label) && !seen.has(label)) {
          seen.add(label)
          await writeFile(join(artifactRoot, "sidebar-" + observed.indexOf(label) + ".txt"), screen)
          console.log("Sidebar phase", label)
        }
      const state = await rpc.list({ sessionID: session.id }, options)
      for (const review of state.reviews.filter((r) => r.status === "pending" && !approved.has(r.id))) {
        expect(JSON.stringify(review.candidate)).not.toContain("PRIVATE_WORKSPACE_SENTINEL")
        expect(JSON.stringify(review.candidate)).not.toContain(directory)
        const label = review.kind === "redaction" ? "Material review" : "Outbound review"
        await until(
          async () =>
            tui.screen().includes(label + " · revision") && tui.screen().includes("Ctrl+A Approve")
              ? true
              : undefined,
          label,
          15000,
        )
        await writeFile(join(artifactRoot, "sidebar-" + review.kind + ".txt"), tui.screen())
        tui.write("\x01")
        await until(
          async () =>
            (await rpc.get({ id: review.id, sessionID: session.id }, options)).status === "approved"
              ? true
              : undefined,
          "native approval",
          15000,
        )
        approved.add(review.id)
      }
      const info = await client.session.get({ sessionID: session.id })
      if (info.outcome === "failed" || info.outcome === "interrupted")
        throw new Error("Live research " + info.outcome)
      return info.outcome === "succeeded" ? state : undefined
    }, "live sidebar research")
    expect(result.reviews.filter((r) => r.status === "approved").length).toBeGreaterThanOrEqual(2)
    expect(result.runs[0]?.status).toBe("completed")
    expect(seen.has("Cloud collaboration · Reasoning") || seen.has("Latest progress")).toBe(true)
    expect(seen.has("websearch") || seen.has("webfetch")).toBe(true)
    await until(
      async () => (tui.screen().includes("Results returned · 1 completed") ? true : undefined),
      "delivered sidebar",
      15000,
    )
    await writeFile(join(artifactRoot, "sidebar-final.txt"), tui.screen())
    const child = await client.session.context({ sessionID: result.runs[0]!.childID })
    await writeFile(join(artifactRoot, "sidebar-cloud.json"), JSON.stringify(child, null, 2))
    expect(child.filter((m) => m.type === "assistant").length).toBeGreaterThan(1)
    const history = await client.session.context({ sessionID: session.id })
    const answer = history.findLast((m) => m.type === "assistant")
    expect(
      answer?.type === "assistant" &&
        answer.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
    ).not.toMatch(/child\s*agent|parent\s*agent|agent loop/i)
    tui.resize(80, 24)
    await Bun.sleep(500)
    tui.write("/xcospan-status")
    await until(
      async () => (tui.screen().includes("XCoSpan: Status") ? true : undefined),
      "narrow status command",
      15000,
    )
    tui.write("\r")
    await until(
      async () => (tui.screen().includes("XCoSpan · Progress and usage") ? true : undefined),
      "narrow panel",
      15000,
    )
    await writeFile(join(artifactRoot, "sidebar-narrow.txt"), tui.screen())
    expect(tui.screen()).not.toContain("child agent")
  } finally {
    await writeFile(join(artifactRoot, "sidebar-tui.txt"), tui.screen())
    await client.session.interrupt({ sessionID: session.id, resume: false })
    await tui.close()
  }
}, 1860000)

test("real file collaboration uses the native TUI for edits and both confirmations", async () => {
  const start = records.length
  const session = await client.session.create({
    location: { directory },
    agent: "xcospan",
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
  })
  const rpc = client.rpc(XCoSpan)
  const options = { location: { directory } }
  const tui = terminal(
    [process.env.OPENCODE_BIN ?? "opencode", "--server", hostURL, "--session", session.id, directory],
    env,
  )
  const screen = tui.screen
  const approved = new Set<string>()
  try {
    await until(async () => (screen().includes("xcospan") ? true : undefined), "TUI startup", 15000)
    await client.session.prompt({
      sessionID: session.id,
      text: "Read customers.csv, analyze customer revenue changes and concentration risk, and use cloud collaboration to recommend business improvements. Redact customer names, contacts, and phone numbers first, preserving the amounts and relationships needed for analysis.",
    })
    const state = await until(async () => {
      const state = await rpc.list({ sessionID: session.id }, options)
      for (const review of state.reviews.filter(
        (item) => item.status === "pending" && !approved.has(item.id),
      )) {
        const title = review.kind === "redaction" ? "Material review" : "Outbound review"
        await until(
          async () =>
            screen().includes(`${title} · revision ${review.revision}`) && screen().includes("Ctrl+A Approve")
              ? true
              : undefined,
          title,
          15000,
        )
        if (review.kind === "redaction")
          for (const secret of [
            "Starport Manufacturing",
            "Riverbend Trading",
            "Alex Chen",
            "Jordan Zhao",
            "13800138000",
            "13900139000",
          ])
            expect(JSON.stringify(review.candidate)).not.toContain(secret)
        tui.write("\x05")
        await until(
          async () =>
            screen().includes((review.kind === "redaction" ? "Redacted content" : "Task goal") + " · Tab")
              ? true
              : undefined,
          "editable TUI",
          15000,
        )
        const fields: [string, string][] = [
          [
            "Task goal",
            "Review note: Analyze customer revenue changes and concentration risk, and recommend business improvements.",
          ],
          [
            "Related context",
            "The user has reviewed the attached anonymized customer table. Analyze both years of revenue while preserving the relationships between customers and amounts.",
          ],
          [
            "Expected output",
            "Preserve numerical evidence and give targeted business recommendations with their applicability conditions.",
          ],
        ]
        if (review.kind === "outbound") {
          // OpenCode's managed textarea binds Super+A to select the complete buffer.
          // The test operator replaces all model-composed fields before approving.
          for (const [index, [label, value]] of fields.entries()) {
            await until(async () => (screen().includes(label + " · Tab") ? true : undefined), label, 15000)
            tui.write("\x1b[97;9u")
            tui.write("\x1b[200~" + value + "\x1b[201~")
            await until(
              async () => (screen().includes(value.slice(0, 12)) ? true : undefined),
              "typed field",
              15000,
            )
            if (index < fields.length - 1) tui.write("\t")
          }
        } else {
          tui.write("\x01Review note: Preserve the numerical evidence.")
          await until(async () => (screen().includes("Review note") ? true : undefined), "typed edit", 15000)
        }
        tui.write("\x13")
        const saved = await until(
          async () => {
            const saved = await rpc.get({ id: review.id, sessionID: session.id }, options)
            return saved.revision === review.revision + 1 ? saved : undefined
          },
          "saved revision",
          15000,
        )
        if (review.kind === "outbound") {
          const task = Task.parse(saved.candidate)
          expect([task.goal, task.context, task.expectedOutput]).toEqual(fields.map(([, value]) => value))
        }
        for (const secret of [
          "Starport Manufacturing",
          "Riverbend Trading",
          "Alex Chen",
          "Jordan Zhao",
          "13800138000",
          "13900139000",
        ])
          expect(JSON.stringify(saved.candidate)).not.toContain(secret)
        tui.write("\x01")
        await until(
          async () =>
            (await rpc.get({ id: review.id, sessionID: session.id }, options)).status === "approved"
              ? true
              : undefined,
          "approved revision",
          15000,
        )
        approved.add(review.id)
      }
      const status = await client.session.get({ sessionID: session.id })
      if (status.outcome === "failed" || status.outcome === "interrupted")
        throw new Error(`Session ${status.outcome}`)
      return status.outcome === "succeeded" ? state : undefined
    }, "file collaboration")
    const history = await client.session.context({ sessionID: session.id })
    await writeFile(join(artifactRoot, "file-session.json"), JSON.stringify(history, null, 2))
    expect(state.reviews.some((item) => item.kind === "redaction" && item.status === "approved")).toBe(true)
    expect(state.reviews.some((item) => item.kind === "outbound" && item.status === "approved")).toBe(true)
    expect(state.runs.some((item) => item.status === "completed")).toBe(true)
    expect(
      JSON.stringify(state.reviews.filter((item) => item.kind === "redaction").map((item) => item.original)),
    ).toContain("168")
    const outbound = JSON.stringify(records.slice(start).filter((item) => item.role === "cloud"))
    expect(outbound).toContain("Review note")
    for (const secret of [
      "Starport Manufacturing",
      "Riverbend Trading",
      "Alex Chen",
      "Jordan Zhao",
      "13800138000",
      "13900139000",
      "PRIVATE_WORKSPACE_SENTINEL",
      directory,
    ])
      expect(outbound).not.toContain(secret)
  } finally {
    await writeFile(join(artifactRoot, "tui.txt"), screen())
    await writeFile(
      join(artifactRoot, "file-session.json"),
      JSON.stringify(await client.session.context({ sessionID: session.id }), null, 2),
    )
    await tui.close()
  }
}, 1860000)
