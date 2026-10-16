# Changelog

## Unreleased

### Collaboration

- Per-request local/cloud routing with configurable model roles and a strict `{ reason, route: 0 | 1 }` service contract.
- Capability-based routing and text redaction through English model instructions.
- Text and optional image redaction review, editable outbound approval, and version-bound delegation.
- Progress, cancellation, recovery, and result delivery through OpenCode sessions.
- User cancellation stops the active task and concurrent reviews; subsequent requests start normally.
- Session deletion removes associated review and run records, including deletions made while the plugin was unloaded.
- Recovery reports deleted collaboration sessions.

### Setup and materials

- `/xcospan` model configuration, connection checks, and lifecycle controls.
- Saving unchanged model settings keeps collaboration available and completes immediately.
- Installation, update, and removal through OpenCode plugin commands.
- A materials Skill for task-driven extraction and source verification.
- Package documentation and diagrams with validated relative links.

### Verification

- Package verification on Linux, macOS, and Windows with Node.js 22 and 24.
- Native Windows terminal tests using ConPTY, OCR data, and special-character workspaces.
- Provider credentials, environment credentials, and account-store authentication coverage.
- A real-model TUI journey covering local execution, text and file collaboration, and return to local execution in one session.
- Tarball installation, release validation, and npm publication workflows.
- Commit-history secret scanning and dependency audits in pull-request verification.
