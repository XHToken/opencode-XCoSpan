# Changelog

## Unreleased

- User cancellation stops the native task and concurrent reviews; subsequent requests start normally.

- Session deletion removes associated private review and run records, including deletions made while the plugin was unloaded.
- Recovery reports a deleted collaboration session explicitly.
- Commit-history secret scanning and dependency audits run with pull-request verification.
- Package documentation uses validated relative links and documents extraction architecture limits.

- English algorithm prompts for capability-based binary routing and comprehensive text redaction, integrated with native model calls and both review stages.
- Strict `{ reason, route: 0 | 1 }` routing service contract with explicit session-state mapping.

- Native Windows package verification with Node.js 22 and 24, OCR data, and ConPTY terminal tests.
- Portable process-tree cleanup, consistent text line endings, and special-character workspace coverage.
- Native environment and account credential tests, plus platform and provider compatibility guidance.

## Initial feature set (unreleased)

- Per-request local/cloud routing with configurable model roles.
- Text and optional image redaction review, editable outbound approval, and version-bound delegation.
- Native progress, cancellation, recovery, and verified result delivery.
- Unified material extraction Skill and native OpenCode TUI model setup, review, and lifecycle controls.
- Native `opencode plugin add` onboarding, update and removal instructions, and contributor-only source setup.
- Cross-platform artifact testing, release rehearsal, and authenticated npm publishing.
- A real-model TUI journey covering local work, reviewed text and file collaboration, and a return to local work in one session.
