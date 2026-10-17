# Changelog

## Unreleased

### Collaboration

- Per-request local/cloud routing with configurable model roles and a strict `{ reason, route: 0 | 1 }` service contract.
- Capability-based routing and text redaction through English model instructions. Routing assesses local execution tools independently of cloud delegation.
- Text and optional image redaction review, editable outbound approval, and version-bound delegation.
- Text material references and compact approval receipts reduce repeated content in the local model context.
- Reviewed task handoffs and reference-only delegation arguments; the local model submits task instructions for review before selecting approved content for cloud collaboration.
- Route-scoped collaboration guidance and approved material references supplied directly in model context.
- Cloud delegation remains discoverable throughout cloud-routed requests; execution enforces material approval.
- Routing history limited to 1,000 Unicode characters across up to three recent user turns.
- Progress, cancellation, recovery, and result delivery through OpenCode sessions.
- Collaboration stages restore from persisted task and review records when a terminal connects or reconnects.
- User cancellation stops the active task and concurrent reviews; subsequent requests start normally.
- Session deletion removes associated review and run records, including deletions made while the plugin was unloaded.
- Recovery reports deleted collaboration sessions.

### Setup and materials

- `/xcospan` model configuration, connection checks, and lifecycle controls.
- Saving unchanged model settings keeps collaboration available and completes immediately.
- Installation, update, and removal through OpenCode plugin commands.
- A materials Skill for task-driven extraction and source verification, with complete readable text export to a new local file.
- Package documentation and diagrams with validated relative links.

### Verification

- Package verification on Linux, macOS, and Windows with Node.js 22 and 24.
- Native Windows terminal tests using ConPTY, OCR data, and special-character workspaces.
- Provider credentials, environment credentials, and account-store authentication coverage.
- A real-model TUI journey covering local execution, text and file collaboration, and return to local execution in one session.
- A live quality check that approves model-generated candidates unchanged and checks privacy boundaries before cloud submission.
- Tarball installation, release validation, and npm publication workflows.
- Commit-history secret scanning and dependency audits in pull-request verification.
