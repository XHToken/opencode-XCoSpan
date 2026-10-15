import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile, rename, rm, stat } from "node:fs/promises"
import { dirname, resolve, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  findNodeAtLocation,
  createScanner,
  SyntaxKind,
  type ParseError,
} from "jsonc-parser"
import type { Plugin } from "@opencode/plugin"
import { Host } from "@opencode/plugin/host"
import { z } from "zod"
import { Config, ModelRef } from "./types"
import { ActionError } from "./errors"

import { SettingsDocument, SettingsInput, CustomProvider } from "./settings-schema"

type Document = z.infer<typeof SettingsDocument> & { index: number }
const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
export function parseSettings(text: string): Record<string, any> {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value))
    throw new ActionError("Configuration is not valid JSON / JSONC")
  return value
}
export function editSettings(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, path, value, { formattingOptions }))
}
/** Remove the entry and its separator using syntax offsets, preserving surrounding comments. */
export function removePlugin(text: string, index: number) {
  parseSettings(text)
  const tree = parseTree(text, [], { allowTrailingComma: true })!
  const array = findNodeAtLocation(tree, ["plugins"])
  const node = array?.children?.[index]
  if (!array || !node) throw new ActionError("Plugin configuration entry is stale")
  const scanner = createScanner(text, true)
  scanner.setPosition(node.offset + node.length)
  const edits = [{ offset: node.offset, length: node.length, content: "" }]
  if (scanner.scan() === SyntaxKind.CommaToken) {
    edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" })
  } else if (index > 0) {
    const previous = array.children![index - 1]!
    scanner.setPosition(previous.offset + previous.length)
    if (scanner.scan() !== SyntaxKind.CommaToken) throw new ActionError("Invalid plugin entry separator")
    edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" })
  }
  return applyEdits(text, edits)
}
function normalized(target: string, path: string) {
  if (target.startsWith("file://")) return fileURLToPath(target)
  return target.startsWith(".") ? resolve(dirname(path), target) : target
}
const locks = new Set<string>()

/** Mutations use a server-issued snapshot; callers never provide replacement file contents. */
export class Settings {
  private documents = new Map<string, Document>()
  constructor(private ctx: Plugin.Context) {}
  async inspect(paths: string[]) {
    const installed = (await this.ctx.plugin.list()).data.find((plugin) => plugin.id === "xcospan")
    if (!installed || !["local", "package"].includes(installed.source.type))
      throw new ActionError("This installation source does not support configuration editing")
    const source = installed.source
    const target = source.type === "local" ? source.path : source.type === "package" ? source.target : ""
    const result: z.infer<typeof SettingsDocument>[] = []
    for (const path of [...new Set(paths)]) {
      const text = await readFile(path, "utf8")
      const config = parseSettings(text)
      const entries: unknown[] = config.plugins ?? []
      for (let index = 0; index < entries.length; index++) {
        const item = entries[index]
        const spec = typeof item === "string" ? item : (item as { package?: string })?.package
        if (!spec) continue
        const resolved = normalized(spec, path)
        const matches =
          source.type === "local" && isAbsolute(resolved)
            ? Host.resolve({ directory: resolved }).server === pathToFileURL(target).href
            : resolved === target
        if (!matches) continue
        const token = hash(JSON.stringify([path, text, index]))
        for (const [key, old] of this.documents)
          if (old.path === path && old.revision !== hash(text)) this.documents.delete(key)
        const document = { token, path, target: spec, revision: hash(text), index }
        this.documents.set(token, document)
        result.push({ token, path, target: spec, revision: document.revision })
      }
    }
    if (!result.length)
      throw new ActionError(
        "The plugin was discovered from a directory or in-memory configuration. Add its package entry to OpenCode configuration before setup.",
      )
    return result
  }
  private async change(
    token: string,
    revision: string,
    update: (text: string, document: Document) => string,
  ) {
    const document = this.documents.get(token)
    if (!document) throw new ActionError("Setup is stale; reopen /xcospan")
    if (locks.has(document.path)) throw new ActionError("Another client is saving; reload")
    locks.add(document.path)
    const temporary = document.path + "." + randomUUID() + ".tmp"
    try {
      const text = await readFile(document.path, "utf8")
      if (hash(text) !== revision || revision !== document.revision)
        throw new ActionError("Another client changed the configuration; reload")
      const next = update(text, document)
      parseSettings(next)
      const mode = (await stat(document.path)).mode
      await writeFile(temporary, next, { mode, flag: "wx" })
      if (hash(await readFile(document.path, "utf8")) !== revision)
        throw new ActionError("Configuration changed during save; reload")
      await rename(temporary, document.path)
      this.documents.delete(token)
    } finally {
      locks.delete(document.path)
      await rm(temporary, { force: true })
    }
  }
  async save(input: z.infer<typeof SettingsInput>) {
    if (input.enabled) await this.validateModels(input)
    await this.change(input.token, input.revision, (text, doc) => {
      const item = parseSettings(text).plugins[doc.index]
      const options = typeof item === "string" ? {} : (item.options ?? {})
      const original = parseSettings(text)
      const previousDefaultAgent =
        input.defaultAgent === true && original.default_agent !== "xcospan"
          ? (original.default_agent ?? null)
          : options.previousDefaultAgent
      const config = Config.parse({
        ...options,
        ...(previousDefaultAgent !== undefined ? { previousDefaultAgent } : {}),
        localModel: input.localModel,
        cloudModel: input.cloudModel,
        enabled: input.enabled,
      })
      let next = editSettings(text, ["plugins", doc.index], { package: doc.target, options: config })
      if (input.defaultAgent === true) next = editSettings(next, ["default_agent"], "xcospan")
      if ((input.defaultAgent === false || !input.enabled) && parseSettings(next).default_agent === "xcospan")
        next = editSettings(next, ["default_agent"], config.previousDefaultAgent ?? undefined)
      return next
    })
  }
  async provider(token: string, revision: string, input: z.infer<typeof CustomProvider>) {
    const url = new URL(input.baseURL)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new ActionError("Use an HTTP / HTTPS endpoint; configure credentials through /connect")
    await this.change(token, revision, (text) => {
      if (parseSettings(text).providers?.[input.id]) throw new ActionError("This provider ID already exists")
      return editSettings(text, ["providers", input.id], {
        package: "@opencode/ai/providers/" + input.protocol,
        settings: { baseURL: input.baseURL },
        models: {
          [input.modelID]: {
            capabilities: { tools: true },
            limit: { context: input.context, output: input.output },
          },
        },
      })
    })
  }
  async remove(token: string, revision: string) {
    await this.change(token, revision, (text, doc) => {
      const previous = parseSettings(text).plugins[doc.index]?.options?.previousDefaultAgent
      let next = removePlugin(text, doc.index)
      if (parseSettings(next).default_agent === "xcospan")
        next = editSettings(next, ["default_agent"], previous ?? undefined)
      return next
    })
  }
  async validateModels(input: {
    localModel: z.infer<typeof ModelRef>
    cloudModel: z.infer<typeof ModelRef>
  }) {
    const models = (await this.ctx.model.list()).data
    for (const ref of [input.localModel, input.cloudModel]) {
      const model = models.find((model) => model.id === ref.id && model.providerID === ref.providerID)
      if (!model || !model.enabled)
        throw new ActionError("Model unavailable: " + ref.providerID + "/" + ref.id)
      if (!model.capabilities.tools)
        throw new ActionError("Model catalog does not declare tool calling: " + ref.providerID + "/" + ref.id)
    }
  }
}
