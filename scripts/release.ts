import { appendFile } from "node:fs/promises"
import { prerelease, valid } from "semver"

export function releaseMetadata(version: string, ref?: string) {
  if (valid(version) !== version) throw new Error("Package version must be canonical SemVer")
  const tag = "v" + version
  if (ref && ref !== tag) throw new Error("Release tag must match package version: " + tag)
  return { version, tag, channel: prerelease(version) ? "next" : "latest" }
}

if (import.meta.main) {
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  const release = releaseMetadata(manifest.version, process.argv[2])
  for (const [key, value] of Object.entries(release)) {
    console.log(key + "=" + value)
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, key + "=" + value + "\n")
  }
}
