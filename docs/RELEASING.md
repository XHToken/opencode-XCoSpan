# Releasing

## Repository configuration

- Set `main` as the default branch. Pull requests target `main`; Check validates pushes and pull requests for that branch.
- Configure the `npm` environment with `NPM_TOKEN`, a granular token with publication rights to the package scope. Publication checks for this secret before the verification matrix. Validation runs with `publish=false` do not require publication credentials.
- Configure the `live-tests` environment with `XCOSPAN_LIVE_CONFIG` using the schema in [Testing](../test/README.md#live-model-configuration). Live models checks for this secret before installing dependencies.
- Apply the desired environment approval rules. A publication can require approval for both its credential check and its publishing job.
- Protect `main` against force pushes and deletion, and require the Check jobs before merging. Branch protection and environment controls depend on repository permissions and the GitHub plan.
- Check the repository's Actions page after changes to branches or workflow settings. Verify the intended triggers and results before publishing a version.

## Pipeline

```text
Pull request / main
  -> workflow and shell validation
  -> commit-history secret scan and dependency audit
  -> Linux + macOS + Windows, Node 22 + 24
  -> types, formatting, unit tests
  -> build and inspect npm tarball
  -> native plugin add / check / update / remove against the tarball registry
  -> clean npm install -> native host and TUI tests
  -> clean Bun install -> exports and native extraction
  -> npm publish --dry-run
  -> verified tarball + SHA-256 artifact

Version tag on main
  -> exact version and source validation
  -> the same verification pipeline
  -> verify artifact checksum -> publish that tarball with NPM_TOKEN
  -> GitHub release with the published tarball and checksum
```

Build and host versions come from `package.json`. Actions are pinned to commit SHAs. Runtime package tests install from the tarball in temporary consumer directories. Publish jobs use the verified tarball and checksum produced by the verification job.

## Validate a release

Run the Release workflow manually on a branch, leaving `publish` disabled:

```sh
gh workflow run release.yml --ref main -f publish=false
```

With `publish=false`, the workflow runs version checks, platform verification, artifact transfer, checksum verification, and `npm publish --dry-run`. Registry upload requires `publish=true` and publication credentials.

For local artifact verification:

```sh
bun run check
bun run test:package --output dist/release
bun run test:package --artifact /absolute/path/to/package.tgz
```

Download the `npm-package` artifact from a successful workflow to inspect the exact candidate.

## npm credentials

The package name and `publishConfig` in `package.json` define the destination. Confirm the signed-in account has publish rights to its scope with `npm whoami` and npm's package or organization settings.

The release workflow reads `NPM_TOKEN` from GitHub Actions secrets. Configure a granular token with publish access to `@iflytekopensource` and Bypass 2FA enabled. Store the token in the secret manager, track its expiry, and rotate it before expiration. npm limits write tokens to 90 days. Use a prerelease version and an explicit `next` or `test` dist-tag during testing.

## Trusted publishing configuration

npm is retiring direct publication with bypass-2FA tokens in January 2027. To migrate the release workflow to OIDC, configure the package's trusted publisher:

| Field             | Value                                |
| ----------------- | ------------------------------------ |
| GitHub owner      | `XHToken`                            |
| Repository        | `opencode-XCoSpan`                   |
| Workflow filename | `release.yml`                        |
| Environment       | `npm`                                |
| Allowed action    | Direct publishing with `npm publish` |

The GitHub `npm` environment can require maintainer review. For the OIDC migration, grant the publishing job `id-token: write`, remove `NODE_AUTH_TOKEN`, and retain npm 12.2.0 or later. Ensure the package's repository URL matches the publishing repository. Verify an actual publication before retiring the token.

New trusted-publisher configurations must complete their first successful publication within 48 hours. npm generates provenance for public packages from public repositories; private repositories do not produce that provenance. Maintainers manage repository visibility in GitHub settings.

## Publish a version

1. Update `package.json`, `bun.lock`, and `CHANGELOG.md` together. Describe user-visible changes and breaking contracts. Documentation and diagrams use relative links and ship in the package; artifact validation checks their targets. Verify README rendering on GitHub and npm after publication.
2. Merge the reviewed revision into `main` and inspect its CI result.
3. Push a tag matching the exact version, such as `v0.1.0` or `v0.2.0-rc.1`. The Release workflow rejects version mismatches and commits outside `main`.
4. Approve the GitHub environment if configured. Stable versions publish to `latest`; prereleases publish to `next`.
5. Verify the registry version, dist-tag, and integrity, then run the README's unversioned `opencode plugin add @iflytekopensource/opencode-xcospan` command in a clean OpenCode environment. Confirm existing model accounts, `/xcospan` setup, update and removal. Run the [real-model quick-start journey](../test/README.md#live-model-configuration) with `XCOSPAN_INSTALL_SPEC` set to the published package to verify registry installation through delivery.

For a manual publish, select the existing version tag and enable `publish`. Manual branch runs perform release validation. Publication requires a version tag.

Publishing failures fail the workflow. If npm accepted a version but GitHub release creation failed, rerun only the failed job; do not republish that version. npm versions are immutable.

## Temporary registry tests

Use a unique prerelease version with an explicit `test` dist-tag. Publish the verified tarball, download that exact version from npm, compare its integrity, and run `test:package --artifact` against the downloaded file.

Remove only the test version with `npm unpublish <name>@<test-version>`. Verify that the version and its dist-tag are no longer available. Unpublishing the last version may require `--force` and prevents new publications under that package name for 24 hours; the removed version can never be reused. Plan tests around that registry constraint.

## Workflow navigation

Open [Actions](https://github.com/XHToken/opencode-XCoSpan/actions) for run history, or select a workflow below to inspect its runs and available manual inputs. Manual runs use the selected branch or tag.

| Workflow                                                                                       | Trigger                                | Purpose                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| [Check](https://github.com/XHToken/opencode-XCoSpan/actions/workflows/check.yml)               | Push or pull request to `main`; manual | Run shared repository and package verification                 |
| [Verify](https://github.com/XHToken/opencode-XCoSpan/blob/main/.github/workflows/verify.yml)   | Called by Check and Release            | Define shared security, workflow, and platform checks          |
| [Dependency audit](https://github.com/XHToken/opencode-XCoSpan/actions/workflows/security.yml) | Weekly; manual                         | Check dependency advisories                                    |
| [Live models](https://github.com/XHToken/opencode-XCoSpan/actions/workflows/live.yml)          | Manual                                 | Exercise configured providers and native terminal interactions |
| [Release](https://github.com/XHToken/opencode-XCoSpan/actions/workflows/release.yml)           | Version tag; manual                    | Validate or publish a version using the selected inputs        |

## Other workflows

- **Live models:** explicit manual run with the `live-tests` environment's `XCOSPAN_LIVE_CONFIG` secret. Supply the JSON schema in [Testing](../test/README.md), with credentials resolved in provider settings. The runner deletes configuration and request diagnostics after the run. Paid model tests never run for pull requests.
- **Dependency audit:** every verification run, plus weekly and manually triggered `bun audit`.
- **Dependabot:** automatic version-update pull requests are paused for Bun and GitHub Actions (`open-pull-requests-limit: 0`). Security-update settings remain unchanged. Maintainers review dependency upgrades alongside the verification checks.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
- [Dependabot ecosystem support](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
