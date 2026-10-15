import { expect, test } from "bun:test"
import { releaseMetadata } from "../../scripts/release"

test("stable and prerelease versions use separate npm channels", () => {
  expect(releaseMetadata("1.2.3", "v1.2.3")).toEqual({
    version: "1.2.3",
    tag: "v1.2.3",
    channel: "latest",
  })
  expect(releaseMetadata("1.2.3-rc.1", "v1.2.3-rc.1").channel).toBe("next")
})

test("release tags must identify the exact package version", () => {
  expect(() => releaseMetadata("1.2.3", "v1.2.4")).toThrow("match package version")
  expect(() => releaseMetadata("1.2.3-rc.1", "v1.2.3")).toThrow("match package version")
})

test("release versions must be canonical SemVer", () => {
  for (const version of ["v1.2.3", "1.2", "01.2.3", "latest", "1.2.3-01"])
    expect(() => releaseMetadata(version)).toThrow("canonical SemVer")
})
