import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { extractMaterial } from "../../skills/materials/extract"

const directory = await realpath(await mkdtemp(join(tmpdir(), "xcospan materials ")))
const fixtures = resolve(import.meta.dir, "../fixtures/materials")
afterAll(() => rm(directory, { recursive: true, force: true }))

test.each([
  ["inspection.doc", "SAMPLE-731"],
  ["inspection.docx", "SAMPLE-731"],
  ["deployment.pptx", "SAMPLE-842"],
  ["procurement-terms.pdf", "82 working days"],
  ["procurement-items.xlsx", "55000"],
])("extracts actual %s bytes and preserves source identity", async (name, fact) => {
  const path = join(directory, "\u00e9 \u6750\u6599 # " + name)
  await copyFile(join(fixtures, name), path)
  const before = await readFile(path)
  const result = await extractMaterial(path)
  expect(result.source).toBe(await realpath(path))
  expect(result.sha256).toBe(createHash("sha256").update(before).digest("hex"))
  expect(result.results?.map((doc) => doc.content).join("\n")).toContain(fact)
  expect(await readFile(path)).toEqual(before)
})

test.each([
  ["notes.txt", "Run SAMPLE-101\nPreserve 42 units.", "SAMPLE-101"],
  [
    "page.html",
    "<html><body><h1>Experiment</h1><p>SAMPLE-202</p><table><tr><td>Result</td><td>17</td></tr></table></body></html>",
    "SAMPLE-202",
  ],
  ["records.csv", "Reference,Quantity\nSAMPLE-303,19\n", "SAMPLE-303"],
  ["record.json", '{"reference":"SAMPLE-404","quantity":23}', "SAMPLE-404"],
  ["memo.rtf", "{\\rtf1\\ansi Inspection SAMPLE-505\\par Passed.}", "SAMPLE-505"],
  [
    "letter.eml",
    "From: sender@example.com\r\nTo: receiver@example.com\r\nSubject: Sample\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSAMPLE-606 inspection passed.",
    "SAMPLE-606",
  ],
])("uses the engine registry for %s", async (name, content, fact) => {
  const path = join(directory, name)
  await writeFile(path, content)
  const result = await extractMaterial(path)
  expect(result.results?.map((doc) => doc.content).join("\n")).toContain(fact)
})

test("preserves spreadsheet sheets and stored values without inventing formula results", async () => {
  const result = await extractMaterial(join(fixtures, "procurement-items.xlsx"))
  const document = result.results![0]!
  expect(document.pages?.map((page) => page.sheetName)).toEqual(["Equipment", "Internal funding plan"])
  expect(document.content).toContain("180000")
  expect(document.content).not.toContain("300200")
})

test("retains PDF page references and Word tables", async () => {
  const pdf = await extractMaterial(join(fixtures, "procurement-terms.pdf"))
  expect(pdf.results![0]!.pages?.[0]?.pageNumber).toBe(1)
  const word = await extractMaterial(join(fixtures, "inspection.docx"))
  expect(JSON.stringify(word.results![0]!.tables)).toContain("Temperature")
})

test("OCR extracts a real scanned image with an explicitly selected language", async () => {
  const result = await extractMaterial(join(fixtures, "shipping-scan.png"), ["eng"])
  expect(result.results![0]!.content).toContain("42 kg")
  expect(result.results![0]!.metadata?.ocrUsed).toBe(true)
}, 30000)

test("reports empty extraction and damaged inputs instead of treating them as material", async () => {
  await expect(extractMaterial(join(fixtures, "shipping-scan.png"))).rejects.toThrow("No readable text")
  const damaged = join(directory, "damaged.pdf")
  await writeFile(damaged, "%PDF-1.7\ninvalid document")
  await expect(extractMaterial(damaged)).rejects.toThrow()
  await expect(extractMaterial(join(directory, "missing.docx"))).rejects.toThrow()
})

test("the shipped CLI lists engine formats and extracts without converter output side effects", async () => {
  const script = resolve(import.meta.dir, "../../skills/materials/extract.ts")
  const formats = Bun.spawn([process.execPath, script, "--formats"], { stdout: "pipe", stderr: "pipe" })
  const available = JSON.parse(await new Response(formats.stdout).text())
  expect(await formats.exited).toBe(0)
  expect(JSON.stringify(available)).toContain("docx")
  const path = join(directory, "fresh source.txt")
  await writeFile(path, "Current source SAMPLE-707")
  await writeFile(join(directory, "fresh source.md"), "Stale unrelated output")
  const child = Bun.spawn([process.execPath, script, path], { stdout: "pipe", stderr: "pipe" })
  const result = JSON.parse(await new Response(child.stdout).text())
  expect(await child.exited).toBe(0)
  expect(result.results[0].content).toContain("SAMPLE-707")
  expect(await Bun.file(join(directory, "fresh source.md")).text()).toBe("Stale unrelated output")
})
