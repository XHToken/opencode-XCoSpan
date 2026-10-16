# Compatibility

## Host and operating systems

XCoSpan targets OpenCode 2.0.27. The package verification workflow is configured for Node.js 22 and 24 on Linux, macOS, and native Windows x64 (Windows Server 2025). It installs the actual tarball with npm and Bun, loads it into OpenCode, and exercises native terminal setup, review, cancellation, recovery, and removal. Test workspaces and materials include spaces, non-ASCII characters, and URL-reserved characters.

The bundled material helper uses Bun 1.4.3 and Xberg 1.3.10. Xberg distributes a native Windows x64 binary. The published Xberg 1.3.10 packages do not include macOS Intel (x64) or Windows ARM64 binaries. The bundled extraction helper cannot run natively on those architectures. Use an available local extraction tool through the model's tools and Skills.

Per-platform validation results are recorded in the verification workflow job logs. The Linux Node.js 24 job also uploads the verified package and checksum.

### Windows quick start

Use Windows Terminal with PowerShell. The [Quick start](../README.md#quick-start) commands are the same on Windows:

```powershell
git clone --depth 1 --branch main https://github.com/XHToken/opencode-XCoSpan.git
cd opencode-XCoSpan
bun install --frozen-lockfile
bun run setup
```

Open your workspace in OpenCode, then enter `/xcospan` to choose accounts and models, test the connection, and start. Keep Bun on the PATH inherited by OpenCode when using the material helper. Install Bun using its [official Windows instructions](https://bun.com/docs/installation), then reopen the terminal and OpenCode.

Quote file paths containing spaces. The helper accepts native drive paths and resolves them through the operating system. It keeps the original file unchanged.

For OCR, install the required language files from [Tesseract's data repository](https://github.com/tesseract-ocr/tessdata_fast), and set `TESSDATA_PREFIX` to the directory containing those files before starting OpenCode. For example, if English data is already installed there:

```powershell
$env:TESSDATA_PREFIX = "C:\Tools\tessdata"
opencode
```

Model credentials supplied through environment variables must also reach the OpenCode service process. Account connections through `/connect` use OpenCode's credential store.

### Terminal behavior

Automated Windows tests use Bun's native ConPTY support. XCoSpan review controls have keyboard shortcuts, including editing, saving, approval, cancellation, and image navigation. Bun documents mouse-tracking limitations on older Windows ConPTY versions; see [platform differences](https://bun.com/docs/runtime/child-process#platform-differences). Windows 11 with Windows Terminal is recommended for interactive use.

## Provider protocols and authentication

The local and cloud roles are independent OpenCode model references. Protocol and authentication handling belongs to the selected native provider package.

| API              | Custom provider selection | Native package                             |
| ---------------- | ------------------------- | ------------------------------------------ |
| Chat Completions | OpenAI Chat Completions   | `@opencode/ai/providers/openai-compatible` |
| Responses        | OpenAI Responses          | `@opencode/ai/providers/openai`            |
| Messages         | Anthropic Messages        | `@opencode/ai/providers/anthropic`         |

Use the endpoint's base address, excluding `/chat/completions` or `/responses`. Use the provider's published model limits. The connection test invokes a tool and reads its result through the actual host.

Native integration tests verify explicit provider credentials, environment credentials, and account-store credentials. They also verify authentication failure and correction. Provider-specific OAuth refresh, command credentials, WebSocket transports, and individual model services require dedicated validation.

Live runs accept arbitrary provider definitions through the [live configuration](../test/README.md#live-model-configuration). Run the same journey for each protocol and role pairing to verify routing, redaction, user review, real delegation, and return to local execution. Validation checks the completed response stream, including `response.failed` events that can follow HTTP 200.

Tool selection follows the provider's requirements for the selected reasoning mode. OpenCode's model loop lets the model choose tools, and provider errors are displayed to the user.
