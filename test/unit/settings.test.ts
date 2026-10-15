import { expect, test } from "bun:test"
import { removePlugin, parseSettings } from "../../src/settings"

test.each([
  '{"plugins":[/* before */"xcospan"/* after */]}',
  '{"plugins":[/* before */"xcospan"/* after */,]}',
  '{"plugins":["other",/* before */"xcospan"/* after */]}',
  '{"plugins":["other",/* before */"xcospan"/* after */,]}',
  '{"plugins":[/* before */"xcospan"/* after */,"other"]}',
])("removal preserves comments and handles separators: %s", (original) => {
  const entries = parseSettings(original).plugins
  const changed = removePlugin(original, entries.indexOf("xcospan"))
  expect(parseSettings(changed).plugins).toEqual(entries.filter((x: string) => x !== "xcospan"))
  expect(changed).toContain("/* before */")
  expect(changed).toContain("/* after */")
})

test.each([0, 2])("JSONC array removal preserves valid configuration (indent %i)", (indent) => {
  const original =
    "// user comment\n" +
    JSON.stringify(
      {
        plugins: [{ package: "other" }, { package: "xcospan", options: { enabled: true } }],
        providers: { fixture: { models: { local: {} } } },
      },
      null,
      indent,
    )
  const changed = removePlugin(original, 1)
  expect(parseSettings(changed).plugins).toEqual([{ package: "other" }])
  expect(changed).toStartWith("// user comment")
})
