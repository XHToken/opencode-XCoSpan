import type { Plugin } from "@opencode/plugin/tui"
import type { ModelInfo } from "@opencode/client"
import { XCoSpan } from "../rpc"
import { errorMessage } from "../status"
import { checkModels, type ModelCheck } from "./model-check"

export function setupManagement(ctx: Plugin.Context) {
  const client = ctx.client.rpc(XCoSpan)
  const [draft, update] = ctx.storage.memory<{
    checks?: ModelCheck[]
    path?: string
    local?: { providerID: string; id: string }
    cloud?: { providerID: string; id: string }
  }>("setup-draft", { initial: {} })
  const [seen, mark] = ctx.storage.store<{ locations: string[] }>("setup-seen", {
    initial: { locations: [] },
  })
  const options = () => {
    const route = ctx.ui.router.current()
    return {
      location: route.type === "session" ? ctx.data.session.get(route.sessionID)?.location : ctx.location,
    }
  }
  const sessionID = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const notify = (message: string) => ctx.ui.toast.show({ title: "XCoSpan", message })
  const fail = (error: unknown) =>
    ctx.ui.toast.show({ title: "XCoSpan", message: errorMessage(error), variant: "error", duration: 12000 })
  async function read() {
    const request = options()
    const entries = await ctx.client.config.get(request)
    return client.settings(
      { paths: entries.flatMap((entry) => (entry.type === "document" && entry.path ? [entry.path] : [])) },
      request,
    )
  }
  async function document(state: Awaited<ReturnType<typeof read>>) {
    if (state.documents.length === 1) return state.documents[0]
    const token = await ctx.ui.dialog.select({
      title: "Choose a configuration source",
      options: state.documents.map((doc) => ({ title: doc.path, value: doc.token })),
    })
    return state.documents.find((doc) => doc.token === token)
  }
  async function idle(state: Awaited<ReturnType<typeof read>>) {
    if (!state.active) return true
    if (
      !(await ctx.ui.dialog.confirm({
        title: "Stop related tasks",
        message: "This project has " + state.active + " active tasks. Stop them and apply changes?",
      }))
    )
      return false
    await client.stop({}, options())
    return true
  }
  async function reload(change: () => Promise<boolean>, check: () => Promise<boolean>) {
    let finished = false
    let checking = false
    let settle!: () => void
    let reject!: (error: unknown) => void
    const done = new Promise<void>((yes, no) => {
      settle = yes
      reject = no
    })
    const unsubscribe = ctx.data.listen(({ details }) => {
      if (!["plugin.updated", "model.updated", "provider.updated", "config.updated"].includes(details.type))
        return
      if (finished || checking) return
      checking = true
      void check()
        .then((ok) => {
          if (ok) settle()
        })
        .catch(reject)
        .finally(() => {
          checking = false
        })
    })
    const timeout = setTimeout(
      () => reject(new Error("Settings saved; host reload is unconfirmed. Check /plugins.")),
      20000,
    )
    // Attach rejection handling before the mutation can trigger a reload.
    const observed = done.catch((error) => {
      throw error
    })
    void observed.catch(() => {})
    try {
      if (!(await change())) return
      if (await check()) settle()
      await observed
    } finally {
      finished = true
      clearTimeout(timeout)
      unsubscribe()
    }
  }
  async function choose(
    title: string,
    current?: { providerID: string; id: string },
  ): Promise<{ providerID: string; id: string } | undefined> {
    await ctx.data.location.model.sync(options().location)
    const models = ctx.data.location.model.list(options().location) ?? []
    const selected = await ctx.ui.dialog.select({
      title,
      placeholder: "Search model name or provider / model ID",
      current: current ? JSON.stringify(current) : undefined,
      options: [
        { title: "Connect an account /connect", value: "@connect" },
        { title: "Add a local or custom provider", value: "@custom" },
        ...models
          .filter((model) => model.enabled)
          .map((model) => ({
            title: model.providerID + "/" + model.id,
            description: model.name,
            footer: model.capabilities.tools ? "Supports tool calling" : "Tool calling not declared",
            value: JSON.stringify({ providerID: model.providerID, id: model.id }),
            disabled: !model.capabilities.tools,
          })),
      ],
    })
    if (selected === "@connect") {
      notify("After connecting, run /xcospan to continue. Your model selections remain in this setup draft.")
      ctx.keymap.dispatch("provider.connect")
      return
    }
    if (selected === "@custom") {
      await custom()
      return
    }
    return selected ? JSON.parse(selected) : undefined
  }
  async function custom() {
    const state = await read()
    const doc = await document(state)
    if (!doc || !(await idle(state))) return
    const prompt = (title: string, description?: string) => ctx.ui.dialog.prompt({ title, description })
    const id = await prompt("Provider ID", "Use letters, numbers, underscores, or hyphens")
    if (!id) return
    const protocol = await ctx.ui.dialog.select({
      title: "Provider protocol",
      options: [
        { title: "OpenAI Chat Completions", value: "openai-compatible" as const },
        { title: "OpenAI Responses", value: "openai" as const },
        { title: "Anthropic Messages", value: "anthropic" as const },
      ],
    })
    if (!protocol) return
    const baseURL = await prompt(
      "API URL",
      "Include the protocol and required API prefix, e.g. http://localhost:8000/v1",
    )
    if (!baseURL) return
    const modelID = await prompt("Model ID")
    if (!modelID) return
    const context = await prompt("Context window", "Enter the token limit supported by the provider")
    if (!context) return
    const output = await prompt("Maximum output", "Enter the token limit supported by the provider")
    if (!output) return
    await reload(
      () =>
        client
          .addProvider(
            {
              token: doc.token,
              revision: doc.revision,
              provider: { id, modelID, baseURL, protocol, context: Number(context), output: Number(output) },
            },
            options(),
          )
          .then(() => true),
      async () =>
        (await ctx.client.model.list(options())).data.some((m) => m.providerID === id && m.id === modelID),
    )
    notify("Provider added. Use /connect for credentials, then /xcospan to continue.")
  }
  function endpoint(model?: ModelInfo) {
    const value = model?.settings?.baseURL
    if (!value) return "Endpoint configured by the host provider"
    const url = new URL(value)
    return url.origin + url.pathname
  }
  async function configure() {
    const state = await read()
    const doc = await document(state)
    if (!doc) return
    if (draft.path !== doc.path)
      update((draft) => {
        draft.path = doc.path
        delete draft.local
        delete draft.cloud
        delete draft.checks
      })
    const selectedLocal = draft.local ?? state.localModel ?? (await choose("Choose the local model"))
    if (!selectedLocal) return
    let local = selectedLocal
    update((draft) => {
      draft.local = local
    })
    const selectedCloud = draft.cloud ?? state.cloudModel ?? (await choose("Choose the cloud model"))
    if (!selectedCloud) return
    let cloud = selectedCloud
    update((draft) => {
      draft.cloud = cloud
    })
    const models = (await ctx.client.model.list(options())).data
    const describe = (ref: typeof local) =>
      ref.providerID +
      "/" +
      ref.id +
      "\n" +
      endpoint(models.find((m) => m.id === ref.id && m.providerID === ref.providerID))
    while (true) {
      const action = await ctx.ui.dialog.select({
        title: "Review model configuration",
        placeholder: "Change either model; checks can be cancelled and results are retained",
        current: "test",
        options: [
          {
            title: "Local model: " + local.providerID + "/" + local.id,
            value: "local",
            description: draft.checks?.[0]?.status ?? "Not checked",
          },
          {
            title: "Cloud model: " + cloud.providerID + "/" + cloud.id,
            value: "cloud",
            description: draft.checks?.[1]?.status ?? "Not checked",
          },
          {
            title: "Test connection and tool calling",
            value: "test",
            description: "Uses synthetic data and incurs provider usage",
          },
          { title: "Save and start", value: "start", description: doc.path },
          { title: "Save only", value: "save", description: doc.path },
        ],
      })
      if (!action) return
      if (action === "local" || action === "cloud") {
        const selected = await choose(
          action === "local" ? "Choose the local model" : "Choose the cloud model",
          action === "local" ? local : cloud,
        )
        if (!selected) return
        if (action === "local") local = selected
        else cloud = selected
        update((draft) => {
          draft[action] = selected
          delete draft.checks
        })
        continue
      }
      if (action === "test") {
        const checks = await checkModels(ctx, [local, cloud], options())
        update((draft) => {
          draft.checks = checks
        })
        continue
      }
      if (
        !(await ctx.ui.dialog.confirm({
          title: "Save model roles",
          label: { confirm: "Continue saving", cancel: "Back to setup" },
          message:
            "Local model\n" +
            describe(local) +
            "\n\nCloud model\n" +
            describe(cloud) +
            "\n\nOriginal queries and local tool results are sent to the local model provider. Cloud collaboration receives the approved task.",
        }))
      )
        continue
      if (!(await idle(state))) return
      const mode = await ctx.ui.dialog.select({
        title: "Default agent for new sessions",
        options: [
          { title: "Keep the current default", value: "keep" },
          { title: "Use XCoSpan by default", value: "xcospan" },
        ],
      })
      if (!mode) return
      await reload(
        () =>
          client
            .saveSettings(
              {
                token: doc.token,
                revision: doc.revision,
                localModel: local,
                cloudModel: cloud,
                enabled: true,
                ...(mode === "xcospan" ? { defaultAgent: true } : {}),
              },
              options(),
            )
            .then((result) => result.changed),
        async () => {
          const next = await client.settings({ paths: [] }, options())
          return (
            next.generation !== state.generation &&
            JSON.stringify(next.localModel) === JSON.stringify(local) &&
            JSON.stringify(next.cloudModel) === JSON.stringify(cloud) &&
            next.enabled
          )
        },
      )
      update((draft) => {
        delete draft.local
        delete draft.cloud
        delete draft.checks
      })
      notify("Model configuration applied")
      if (action === "start") await enter()
      return
    }
  }
  async function enter() {
    const result = await client.enter({ sessionID: sessionID() }, options())
    ctx.ui.router.navigate({ type: "session", sessionID: result.sessionID })
    await ctx.data.session.sync(result.sessionID)
    notify("XCoSpan started")
  }
  async function open() {
    const state = await read()
    const current = sessionID()
    const currentSession = current ? await ctx.client.session.get({ sessionID: current }) : undefined
    const isXCoSpan = currentSession?.agent === "xcospan"
    const hasPrevious = !!currentSession?.metadata?.xcospanPrevious
    async function leaveCurrent() {
      if (!current || !isXCoSpan) return true
      if (ctx.data.session.status(current) === "running") {
        if (
          !(await ctx.ui.dialog.confirm({
            title: "End the current collaboration",
            message: "Stop the current task and switch agents?",
          }))
        )
          return false
        await client.stop({ sessionID: current }, options())
      }
      if (hasPrevious) await client.leave({ sessionID: current }, options())
      else {
        const agents = (await ctx.client.agent.list(options())).data.filter(
          (agent) => agent.id !== "xcospan" && !agent.hidden && agent.mode !== "subagent",
        )
        const chosen = await ctx.ui.dialog.select({
          title: "Choose the next agent",
          options: agents.map((agent) => ({ title: agent.name, value: agent.id })),
        })
        if (!chosen) return false
        const agent = agents.find((agent) => agent.id === chosen)!
        const model = agent.model ?? (await ctx.client.model.default(options())).data
        if (!model) throw new Error("Choose a model through /models first")
        await ctx.client.session.switchAgent({ sessionID: current, agent: chosen })
        await ctx.client.session.switchModel({
          sessionID: current,
          model: { id: model.id, providerID: model.providerID },
        })
      }
      await ctx.data.session.sync(current)
      return true
    }
    const action = await ctx.ui.dialog.select({
      title: "XCoSpan · " + (!state.localModel ? "Not configured" : state.enabled ? "Ready" : "Disabled"),
      options: [
        {
          title: isXCoSpan
            ? hasPrevious
              ? "Return to the previous agent"
              : "Choose another agent"
            : "Start",
          value: "enter",
          disabled: !isXCoSpan && (!state.localModel || !state.enabled),
        },
        {
          title: "Configure models",
          value: "configure",
          description: state.localModel
            ? state.localModel.providerID +
              "/" +
              state.localModel.id +
              " → " +
              state.cloudModel?.providerID +
              "/" +
              state.cloudModel?.id
            : "Choose local and cloud models",
        },
        { title: "Stop the current task", value: "stop", disabled: !isXCoSpan },
        { title: "View reviews and tasks", value: "review", disabled: !current },
        {
          title: state.enabled ? "Disable collaboration" : "Enable collaboration",
          value: "toggle",
          disabled: !state.localModel,
        },
        {
          title: "Remove plugin",
          value: "remove",
          description: "Remove the plugin entry from the selected source",
        },
      ],
    })
    if (!action) return
    if (action === "configure") return configure()
    if (action === "enter") {
      if (!isXCoSpan) {
        if (current && ctx.data.session.status(current) === "running")
          throw new Error("End the current task before switching agents")
        return enter()
      }
      if (await leaveCurrent()) notify(hasPrevious ? "Returned to the previous agent" : "Agent switched")
      return
    }
    if (action === "stop") {
      await client.stop({ sessionID: current }, options())
      notify("Current task stopped")
      return
    }
    if (action === "review") {
      ctx.ui.panel.open("xcospan.status")
      return
    }
    const doc = await document(state)
    if (!doc) return
    if (
      !(await ctx.ui.dialog.confirm({
        title: action === "remove" ? "Remove plugin" : state.enabled ? "Disable XCoSpan" : "Enable XCoSpan",
        message:
          doc.path +
          (action === "remove"
            ? "\nRemove the plugin entry and default xcospan setting here. Keep model accounts, history, reviews, and files. Other configuration sources may still load the plugin."
            : "\nApplies to sessions covered by this configuration source."),
      }))
    )
      return
    if (!(await idle(state))) return
    if (action === "toggle") {
      await reload(
        () =>
          client
            .saveSettings(
              {
                token: doc.token,
                revision: doc.revision,
                localModel: state.localModel!,
                cloudModel: state.cloudModel!,
                enabled: !state.enabled,
              },
              options(),
            )
            .then((result) => result.changed),
        async () => {
          const next = await client.settings({ paths: [] }, options())
          return next.generation !== state.generation && next.enabled !== state.enabled
        },
      )
      notify(state.enabled ? "Collaboration disabled; configuration retained" : "Collaboration enabled")
    } else {
      if (!(await leaveCurrent())) return
      await client.removePlugin({ token: doc.token, revision: doc.revision }, options())
      notify("Plugin entry removed; the host is unloading it. Check /plugins for other sources.")
    }
  }
  async function firstRun() {
    const location = options().location?.directory
    if (!location || seen.locations.includes(location)) return
    const state = await client.status({}, options())
    await mark((draft) => {
      draft.locations.push(location)
    })
    if (!state.ready)
      ctx.ui.toast.show({
        title: "XCoSpan installed",
        message: "Run /xcospan to configure local and cloud models and start",
        duration: 12000,
      })
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "xcospan.manage",
        title: "XCoSpan: Setup and management",
        slash: { name: "xcospan" },
        palette: true,
        run: () => open().catch(fail),
      },
    ],
  }))
  return { firstRun: () => firstRun().catch(fail) }
}
