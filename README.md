# opencode-XCoSpan

**Local work. Cloud capability. Your control.**

[![npm](https://img.shields.io/npm/v/@iflytekopensource/opencode-xcospan)](https://www.npmjs.com/package/@iflytekopensource/opencode-xcospan)
[![OpenCode](https://img.shields.io/badge/OpenCode-2.0.27-202124)](https://opencode.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-60794F)](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/LICENSE)

![Collaboration flow: each new request is routed, the local model plans the work, and local execution or approved cloud collaboration returns to local verification and delivery.](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/assets/readme/01-overview.png)

An OpenCode V2 plugin for reviewed cloud collaboration. The local model organizes the task, uses tools and Skills, and selects relevant materials. The plugin connects routing, redaction, human review, delegation, and result delivery.

| Collaborate on demand                                    | Review what leaves                                             | Follow actual progress                                             |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Route each new request; let the model choose its actions | Edit redacted materials and approve the complete outbound task | Inspect real execution, cancel work, and recover completed results |

[Quick start](#quick-start) · [Review and control](#review-and-control) · [Configuration](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/CONFIGURATION.md) · [Contributing](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/CONTRIBUTING.md)

## Quick start

Requires an existing **OpenCode 2.0.27** installation. XCoSpan reuses your OpenCode provider accounts and model catalog. The bundled file-extraction helper uses **Bun 1.4.3** on your PATH; install it through the [Bun installation guide](https://bun.sh/docs/installation) when using that helper.

![Getting started: install with OpenCode's plugin command, configure two model roles through /xcospan, then send a task. Native commands provide review, progress, cancellation, recovery, and lifecycle controls.](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/assets/readme/03-get-started.png)

**1. Install the plugin**

Run in your terminal:

```sh
opencode plugin add @iflytekopensource/opencode-xcospan
```

OpenCode downloads the package and adds it to your global configuration. Existing provider accounts and workspace settings are retained.

**2. Open your workspace**

Reopen OpenCode after installation. From the directory where you want to work, run:

```sh
opencode
```

**3. Choose models and start**

Enter `/xcospan` in the OpenCode conversation, then follow the interface:

```text
Configure models
  → Choose the local model
  → Choose the cloud model
  → Test connection and tool calling
  → Save and start
  → Confirm model roles and choose the default for new sessions
```

Reuse accounts and models configured in OpenCode. To add an account, select **Connect an account /connect**, finish connecting, then return to `/xcospan`. Use **Add a local or custom provider** for your own endpoint. Both roles require tool calling and may use the same model. Connection tests make real provider requests.

Send your task normally once XCoSpan starts. Review each redaction and the complete outbound task when prompted. For later sessions, open `/xcospan` and select **Start**, or choose **Use XCoSpan by default** during setup.

> A remote provider configured for the local role receives original task inputs and local tool results. Protocols, credentials, and model limits come from OpenCode provider configuration. See [configuration](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/CONFIGURATION.md) and [data boundaries](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/SECURITY.md).

## Review and control

![Two review gates: select and extract relevant content, redact and review each material, assemble the task, then edit and approve the complete outbound revision before cloud collaboration starts.](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/assets/readme/02-review.png)

**After every redaction**, inspect the original and candidate side by side. **Before cloud execution**, review the complete outbound task. Both reviews support editing, approval, and cancellation. Edits create a new revision; approval applies to that revision.

The sidebar follows real execution, showing operations, targets, recent output, and elapsed time. Use `/xcospan-status` in a narrow terminal. Missing usage or pricing is shown as unknown.

| Command            | Purpose                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `/xcospan`         | Configure models, start, return to the previous agent, stop, disable, enable, or remove |
| `/xcospan-review`  | Open pending reviews                                                                    |
| `/xcospan-status`  | Inspect progress, models, and usage                                                     |
| `/xcospan-cancel`  | Select and cancel a cloud task                                                          |
| `/xcospan-recover` | Check and recover delivery of a completed result                                        |

Use `/xcospan` → **Stop the current task** to interrupt the current session's work. **Return to the previous agent** resumes your previous agent and model; a session started directly in XCoSpan offers **Choose another agent**. **Disable collaboration** stops related work and retains model configuration; **Enable collaboration** makes it available again.

**Remove plugin** removes the entry from the selected configuration source. Model accounts, conversation history, reviews, and user files remain available. Check `/plugins` if another configuration source still loads XCoSpan.

<details>
<summary>Review shortcuts and supported materials</summary>

- **Edit and approve:** Ctrl+E to edit, Tab / Shift+Tab to change fields, Ctrl+S to save, Ctrl+A to approve, Ctrl+X to cancel.
- **Compare and inspect images:** Ctrl+D switches comparison views. Ctrl+O opens the image viewer; arrow keys pan, `=` / `-` zoom, and `0` fits the viewport.
- **Local materials:** the bundled `xcospan-materials` Skill guides task-driven selection of text, tables, and visual content. Its extraction helper uses [Xberg](https://github.com/xberg-io/xberg/tree/main/crates/xberg-node) for documents, spreadsheets, presentations, PDFs, markup, email, and other supported formats; `--formats` lists the installed engine's registry.
- **Scans and calculations:** OCR uses explicitly selected local Tesseract language data. Spreadsheet calculations and visual interpretation use suitable local tools. Extraction preserves source references and engine warnings for inspection.
- **Image redaction:** requires a configured local service. See the [capability service contract](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/CONFIGURATION.md#redaction).

</details>

## Update or uninstall

For the npm installation above, use these terminal commands:

```sh
opencode plugin check @iflytekopensource/opencode-xcospan
opencode plugin update @iflytekopensource/opencode-xcospan
```

Stop active work before updating, then reopen OpenCode. To remove the global plugin entry:

```sh
opencode plugin remove @iflytekopensource/opencode-xcospan
```

Use the exact configured package specifier if you installed a version or tag. The `/xcospan` management interface also supports removal from a selected configuration source.

## Documentation and contributing

| Document                                                                                                      | Contents                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Configuration](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/CONFIGURATION.md) | Model setup, routing, and redaction service contracts         |
| [Architecture](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/docs/ARCHITECTURE.md)   | Execution flow, module responsibilities, and host integration |
| [Contributing](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/CONTRIBUTING.md)        | Development setup, checks, and change guidelines              |
| [Testing](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/test/README.md)              | Unit, native host, and real-model validation                  |
| [Security](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/SECURITY.md)                | Data access and deployment boundaries                         |

Package documentation and diagrams are included in every npm release. Repository access is managed by XHToken; members with access can report issues and propose changes in [GitHub](https://github.com/XHToken/opencode-XCoSpan).

[MIT License](https://cdn.jsdelivr.net/npm/@iflytekopensource/opencode-xcospan@0.1.0/LICENSE)
