# Architecture

The plugin uses native OpenCode models, sessions, tools, Skills, RPC, and TUI APIs. The local model chooses the work plan. The plugin integrates routing, enforces review, manages delegation, and presents actual execution progress.

```text
OpenCode parent session
  |
  +-- routing -> capabilities -> decision for this request
  |
  +-- local model <-> local tools / Skills
         |
         +-- redact -> review <-> TUI material review
         |
         +-- cloud_delegate -> review <-> TUI outbound approval
                                  |
                               delegate
                                  |
                         isolated OpenCode session
                            context / network
                                  |
                  actual result -> parent tool -> parent session

TUI <-> RPC <-> reviews / run records / configuration
TUI <-- native session and tool events
```

## Module responsibilities

| Module                                  | Responsibility                                                       |
| --------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                          | Register agents, tools, Skills, and RPC; compose modules             |
| `src/routing.ts`, `src/capabilities.ts` | Per-request routing, model generation, and local capability services |
| `src/redact.ts`, `src/review.ts`        | Redaction tools, candidate revisions, and human review               |
| `src/delegate.ts`                       | Cloud sessions, cancellation, recovery, and result delivery          |
| `src/context.ts`, `src/network.ts`      | Approved context and cloud-tool network boundaries                   |
| `src/management.ts`, `src/settings*.ts` | Model configuration, JSONC edits, lifecycle, and removal             |
| `src/rpc.ts`, `src/types.ts`            | Communication and persistent data contracts                          |
| `src/tui/`, `src/status.ts`             | Setup, review, real execution events, and usage                      |
| `skills/materials/`                     | Task-driven local materials and unified format extraction            |

## Model guidance

`src/prompts.ts` defines the coordinator and cloud worker's system instructions. They describe outcomes, material sufficiency, review continuity, delegation requirements, and evidence-based completion. The model chooses its tools and working sequence from the task and available capabilities. The routing hook adds the current query's decision. Collaboration preparation guidance is injected for cloud-routed requests. After material approval, the context hook supplies the current review ID and the ID-only delegation contract. Relevant Skills provide on-demand operational guidance. Tool execution and persistent state enforce approval, permissions, cancellation, and delivery.

## Execution invariants

- Routing is associated with the user message ID. Tool rounds within one request reuse its decision. Inputs include the current tool descriptions, discovered Skills, and configured model roles. The current query is sent in full. Routing history contains up to three prior user turns, each with the user text and last assistant text, sharing a total budget of 1,000 Unicode characters. Selection prioritizes the latest turn with at most 500 characters per entry, retains chronological order, and marks truncated entries. Historical reasoning and tool payloads are excluded. The parent agent retains its full native context.
- Routing receives the local execution tool catalog; cloud delegation is excluded from local capability assessment.
- Tool registration follows configured capabilities. Image redaction is exposed when a local redaction service is configured; routing reads the resulting tool set.
- The materials Skill defines selection and verification guidance. A small helper delegates format detection and extraction to Xberg's registry, retaining source hashes, pages, tables, and warnings. Its optional `--text-output` writes complete extracted text with readable line breaks to a new local file. The model chooses when to use extraction, OCR, spreadsheet calculation, or visual inspection.
- The model sees `cloud_delegate` throughout a cloud-routed request, including preparation. Its arguments reference approved materials. Execution checks the route, review ownership, and approval state before creating an outbound candidate; incomplete or failed review prevents delegation.
- Prepared text files can be referenced by `redact.files`; native read and external-directory permissions apply. Full source text and approved text stay in review storage instead of being copied into tool arguments and approval results.
- The model prepares task instructions and evidence through material review. `cloud_delegate` accepts only approved review IDs; the plugin uses the first reviewed text as task instructions and attaches the remaining reviewed materials. Final confirmation displays the complete candidate and supports user edits.
- Approval binds the session, tool call, and candidate revision. Cloud delegation receives approved content.
- Tool inputs, results, and persistent records remain associated. Recovery does not rerun completed work.
- Cancellation propagates through the parent session, tool, cloud session, and model request.
- UI state comes from actual events and persistent facts. The model determines the sequence of task actions.

## Package boundary

Root-level `server.ts`, `tui.tsx`, and `rpc.ts` are thin entrypoints required by OpenCode's local directory discovery protocol. They connect the server module, compiled TUI, and RPC contract. Package exports use the same implementation. OpenCode loads server-side TypeScript; `src/tui/` is compiled to `dist/tui.js`, with OpenTUI and Solid supplied by the host's shared runtime.

Users install the registry package with `opencode plugin add @iflytekopensource/opencode-xcospan`, then configure model roles through `/xcospan`. The native installer manages the global package entry; setup and lifecycle controls use the host's configuration sources. `bun run setup` registers a contributor's source checkout.

The package allowlist includes server source, compiled TUI, the shipped Skill, and essential package documentation. Tests, fixtures, build scripts, and local records stay in the development checkout. `test:package` checks the tarball, tests native package commands against an isolated registry, installs it with npm and Bun, and runs real host integration tests. The materials helper runs through Bun on PATH; host-loaded plugin code uses OpenCode's runtime.

API references: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [TUI extensions](https://opencode.ai/v2/docs/build/plugins/cli).
