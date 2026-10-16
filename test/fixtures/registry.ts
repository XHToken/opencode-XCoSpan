import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export async function command(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = Bun.spawn(args, { env, cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(args.join(" ") + "\n" + stdout + stderr)
  return stdout
}

/** Serve the actual packed artifact to OpenCode's native npm installer. */
export async function packageRegistry(directory: string) {
  const root = process.env.XCOSPAN_PACKAGE ?? resolve(import.meta.dir, "../..")
  const artifact = process.env.XCOSPAN_TARBALL
    ? resolve(process.env.XCOSPAN_TARBALL)
    : join(
        directory,
        Object.values(
          JSON.parse(
            await command(
              ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", directory],
              process.env,
              root,
            ),
          ),
        ).map((item) => (item as { filename: string }).filename)[0]!,
      )
  const bytes = await Bun.file(artifact).bytes()
  const contents = await new Bun.Archive(bytes).files("package/package.json")
  const manifest = JSON.parse(await contents.get("package/package.json")!.text())
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64")
  let downloads = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = decodeURIComponent(new URL(request.url).pathname)
      if (path === "/package.tgz") {
        downloads++
        return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })
      }
      if (path === "/" + manifest.name)
        return Response.json({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...manifest,
              dist: { tarball: new URL("package.tgz", server.url).href, integrity },
            },
          },
        })
      return new Response("Unknown registry fixture endpoint", { status: 404 })
    },
  })
  const config = join(directory, "registry.npmrc")
  await writeFile(
    config,
    "registry=https://registry.npmjs.org/\n" + manifest.name.split("/")[0] + ":registry=" + server.url + "\n",
  )
  return {
    name: manifest.name as string,
    version: manifest.version as string,
    env: { npm_config_userconfig: config, npm_config_cache: join(directory, "npm-cache") },
    downloads: () => downloads,
    close: () => server.stop(true),
  }
}
