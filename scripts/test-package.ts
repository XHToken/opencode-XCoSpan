import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { artifact: { type: "string" }, output: { type: "string" } },
})
const root = resolve(import.meta.dir, "..")
const directory = await mkdtemp(join(tmpdir(), "xcospan-package-"))

async function run(command: string[], cwd: string, capture = false, env = process.env) {
  const child = Bun.spawn(command, { cwd, env, stdout: capture ? "pipe" : "inherit", stderr: "inherit" })
  const output = capture ? await new Response(child.stdout).text() : ""
  if ((await child.exited) !== 0) throw new Error(command.join(" ") + " failed")
  return output
}

try {
  const input = values.artifact ? resolve(values.artifact) : undefined
  const output = await run(
    ["npm", "pack", ...(input ? [input, "--ignore-scripts"] : []), "--json", "--pack-destination", directory],
    root,
    true,
  )
  const [artifact] = Object.values(JSON.parse(output)) as { filename: string; files: { path: string }[] }[]
  if (!artifact) throw new Error("Package build produced no artifact")
  const tarball = join(directory, artifact.filename)
  const bytes = await Bun.file(tarball).bytes()
  const checksum = createHash("sha256").update(bytes).digest("hex")
  if (input && !Buffer.from(bytes).equals(Buffer.from(await Bun.file(input).bytes())))
    throw new Error("Artifact changed while preparing installation")
  const contents = await new Bun.Archive(bytes).files()
  const manifest = JSON.parse(await contents.get("package/package.json")!.text())
  const files = new Set(artifact.files.map((file) => file.path))
  const required = [
    ...Object.values(manifest.exports as Record<string, string>).map((path) => path.replace(/^\.\//, "")),
    "skills/materials/SKILL.md",
    "skills/materials/extract.ts",
    "README.md",
    "docs/CONFIGURATION.md",
    "docs/ARCHITECTURE.md",
    "docs/assets/readme/01-overview.png",
    "docs/assets/readme/02-review.png",
    "docs/assets/readme/03-get-started.png",
    "LICENSE",
  ]
  for (const path of required) if (!files.has(path)) throw new Error("Missing package file: " + path)
  const runtime =
    /^(src\/[^/]+\.ts|dist\/tui\.js|skills\/materials\/(SKILL\.md|extract\.ts)|server\.ts|tui\.tsx|rpc\.ts|package\.json|README\.md|CONTRIBUTING\.md|test\/README\.md|docs\/[^/]+\.md|docs\/assets\/readme\/[^/]+\.png|CHANGELOG\.md|SECURITY\.md|LICENSE)$/
  for (const path of files)
    if (!runtime.test(path)) throw new Error("Unexpected file included in package: " + path)
  const readme = await contents.get("package/README.md")!.text()
  const cdn = "https://cdn.jsdelivr.net/npm/" + manifest.name + "@" + manifest.version + "/"
  for (const [, target] of readme.matchAll(/\]\((https:\/\/cdn\.jsdelivr\.net\/npm\/[^)]+)\)/g)) {
    if (!target!.startsWith(cdn)) throw new Error("Documentation version does not match package: " + target)
    const path = target!.slice(cdn.length).split("#")[0]!
    if (!files.has(path)) throw new Error("Documentation target is absent from package: " + path)
  }
  console.log("Verified package contents:", files.size, "runtime and documentation files")

  for (const manager of ["npm", "bun"] as const) {
    const consumer = join(directory, manager)
    await mkdir(consumer)
    await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}')
    const command =
      manager === "npm"
        ? ["npm", "install", "--omit=dev", "--no-audit", "--no-fund", tarball]
        : [process.execPath, "add", tarball]
    await run(command, consumer)
    const installed = join(consumer, "node_modules", manifest.name)
    await run(
      [
        process.execPath,
        "-e",
        "await import(process.argv[1]); await import(process.argv[2])",
        manifest.name,
        manifest.name + "/rpc",
      ],
      consumer,
    )
    const material = JSON.parse(
      await run(
        [
          process.execPath,
          join(installed, "skills/materials/extract.ts"),
          join(root, "test/fixtures/materials/inspection.doc"),
        ],
        consumer,
        true,
      ),
    )
    if (!material.results?.[0]?.content?.includes("SAMPLE-731"))
      throw new Error(manager + " installed material extraction failed")
    console.log("Verified", manager, "installation, exports and native extraction")
    if (manager === "npm") {
      await run([process.execPath, "test", "test/integration", "--timeout", "120000"], root, false, {
        ...process.env,
        XCOSPAN_PACKAGE: installed,
        XCOSPAN_TARBALL: tarball,
      })
    }
  }
  await run(
    [
      "npm",
      "publish",
      tarball,
      "--dry-run",
      "--ignore-scripts",
      "--access",
      "public",
      "--tag",
      "test",
      "--registry=https://registry.npmjs.org",
    ],
    directory,
  )
  if (values.output) {
    const destination = resolve(values.output)
    await mkdir(destination, { recursive: true })
    await copyFile(tarball, join(destination, artifact.filename))
    await writeFile(
      join(destination, artifact.filename + ".sha256"),
      checksum + "  " + artifact.filename + "\n",
    )
    console.log("Verified artifact:", join(destination, artifact.filename))
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
