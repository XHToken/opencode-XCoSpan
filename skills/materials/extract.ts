import { createHash } from "node:crypto"
import { readFile, realpath, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { parseArgs } from "node:util"
import { extract, ExtractInputKind, listSupportedFormats } from "@xberg-io/xberg"

export async function extractMaterial(source: string, languages: string[] = []) {
  const path = await realpath(source)
  const bytes = await readFile(path)
  const result = await extract(
    { kind: ExtractInputKind.Bytes, bytes, filename: basename(path) },
    {
      outputFormat: "markdown",
      useCache: false,
      // Material selection belongs to the agent and reviewer; retain the engine's source content.
      enableQualityProcessing: false,
      postprocessor: { enabled: false },
      contentFilter: {
        includeHeaders: true,
        includeFooters: true,
        includeFootnotes: true,
        includeWatermarks: true,
        stripRepeatingText: false,
      },
      pages: { extractPages: true },
      disableOcr: languages.length === 0,
      ...(languages.length ? { forceOcr: true, ocr: { backend: "tesseract", language: languages } } : {}),
      transcription: { enabled: false, allowNetwork: false },
    },
  )
  if (result.errors?.length)
    throw new AggregateError(
      result.errors.map((error) => new Error(`${error.source}: ${error.message}`)),
      "Material extraction failed",
    )
  if (!result.results?.some((document) => document.content?.trim()))
    throw new Error("No readable text extracted; inspect the source and choose the required representation")
  return { source: path, sha256: createHash("sha256").update(bytes).digest("hex"), ...result }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      formats: { type: "boolean" },
      "ocr-language": { type: "string", multiple: true },
      "text-output": { type: "string" },
    },
  })
  if (values.formats) {
    if (positionals.length || values["ocr-language"]?.length || values["text-output"] !== undefined)
      throw new Error("--formats is a standalone operation")
    console.log(JSON.stringify(listSupportedFormats()))
  } else {
    if (positionals.length !== 1)
      throw new Error(
        "Usage: bun extract.ts <source-file> [--ocr-language <language> ...] [--text-output <new-file>] | --formats",
      )
    const languages = values["ocr-language"] ?? []
    if (languages.some((language) => !language.trim())) throw new Error("OCR language must not be empty")
    const result = await extractMaterial(positionals[0]!, languages)
    if (values["text-output"] !== undefined) {
      await writeFile(
        values["text-output"],
        result.results!.map((document) => document.content).join("\n\n"),
        {
          flag: "wx",
          mode: 0o600,
        },
      )
    }
    console.log(JSON.stringify(result, null, 2))
  }
}
