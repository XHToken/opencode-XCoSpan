# Contributing

Use the supported OpenCode V2 APIs for models, sessions, tools, Skills and TUI. Keep production model choices in configuration and changes focused on a concrete user workflow.

## Community and contribution agreement

This project participates in the [XHToken community](https://github.com/XHToken/community). Contributions follow the [Code of Conduct](CODE_OF_CONDUCT.md). XHToken requires each contributor to sign its [Contributor License Agreement](https://github.com/XHToken/community/blob/main/CLA.md). Contact the [community maintainers](https://github.com/XHToken/community#contact) to complete that process before your contribution is merged.

## Development

Use Bun 1.4.3, Node.js 22+ and OpenCode 2.0.27. `bun.lock` is the dependency lockfile used by development and CI.

```sh
bun install --frozen-lockfile
bun run check
bun run test:package
```

`check` runs type checks, formatting checks and unit tests. `test:package` builds and inspects a tarball, installs it with npm and Bun in clean directories, exercises native extraction and exports, tests native plugin installation/update/removal against an isolated registry serving that artifact, and runs host/TUI integration against the npm installation. The CI matrix includes Linux, macOS, and Windows with Node.js 22 and 24, validates workflow syntax, scans commit history for credentials, audits dependencies, and retains the verified artifact with a checksum. See [test/README.md](test/README.md) for prerequisites and opt-in live tests.

Rebuild with `bun run build` after editing TUI code. OpenTUI and Solid remain external so the plugin uses the host's shared runtime.

## Source setup

To load a source checkout into OpenCode:

```sh
git clone --depth 1 --branch main https://github.com/XHToken/opencode-XCoSpan.git
cd opencode-XCoSpan
bun install --frozen-lockfile
bun run setup
```

`setup` builds the TUI and registers the checkout in global OpenCode configuration, preserving existing settings and comments. Repeating it keeps a single entry. Keep the checkout at the registered location. Reopen OpenCode in your workspace and follow [model setup](README.md#quick-start) through `/xcospan`.

When switching between a source checkout and the npm package, remove the previous entry through `/xcospan` first, then install the chosen source. Check `/plugins` to confirm the active loading source. Native package update commands apply to registry installations; rebuild a source checkout with `bun run build`.

### Update or remove a source checkout

Stop active work, then run these commands from the registered checkout:

```sh
git pull --ff-only origin main
bun install --frozen-lockfile
bun run build
```

Reopen OpenCode after updating. To uninstall, open `/xcospan` → **Remove plugin** for the checkout entry. Confirm removal in `/plugins` before deleting the checkout directory. Source installation requires Git and repository read access.

## Repository boundaries

```text
src/       Runtime code; native TUI under src/tui/
skills/    Shipped capabilities
scripts/   Build and package verification
test/      Unit, host integration and opt-in live tests
  fixtures/  Synthetic materials and test-only plugins
docs/      Configuration and architecture
```

Keep private documents, credentials, personal configuration, request logs and investigation notes outside tracked files. Test output belongs in ignored artifact directories. Test fixtures must be synthetic and reusable. Document current behavior; record change-specific validation in the pull request and CI results.

## Changes

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in project discussions and reviews.

Create a focused branch from `main` and target `main` in pull requests. The [Check workflow](https://github.com/XHToken/opencode-XCoSpan/actions/workflows/check.yml) validates pushes and pull requests for `main`.

- Write documentation, UI text, and model guidance in English. Describe capabilities, prerequisites, actions, outcomes, and relevant limitations directly. Keep wording factual and scoped to the reader's task.
- Use focused commit messages with a type such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`. Describe the resulting behavior; add a scope when it clarifies the affected area.
- Trace callers, exports, tests and documentation before changing a contract.
- Add behavioral coverage for approval versions, cancellation, context filtering and delivery.
- Check APIs against the supported upstream version. Explain breaking changes directly.
- Use real-model tests when changing model interaction. Distinguish fixture evidence, live calls and manual inspection.
- Run the relevant checks and report unverified behavior in the pull request.

## Release

Follow [Releasing](docs/RELEASING.md) for dry runs, npm account setup, version tags, trusted publishing, and temporary registry tests. The release workflow reuses CI verification and publishes the exact tested artifact. Stable and prerelease versions use separate npm channels.

The `files` allowlist defines the artifact; exported entrypoints and Skill resources are checked against the packed files. The package retains service-side TypeScript supported by OpenCode and includes compiled TUI JavaScript. Update the changelog alongside public behavior or contract changes.

Keep the PR description focused on the problem, resulting behavior and verification. Keep dependencies and tooling scoped to the change.

Contributions are provided under the [XHToken community license](https://github.com/XHToken/community/blob/main/LICENSE) (Apache-2.0); the full text is in [LICENSE](LICENSE). Include attribution and license notices required by third-party code or assets.
