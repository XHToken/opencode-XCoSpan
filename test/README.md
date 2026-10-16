# Testing

## Test layers

| Command                    | Scope                                                              | Requirements                                |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `bun run test`             | Unit tests                                                         | Bun, installed dependencies                 |
| `bun run test:integration` | Real OpenCode host and terminal with deterministic model responses | OpenCode 2.0.27 on PATH                     |
| `bun run test:package`     | Build, artifact checks, clean install, then host integration       | OpenCode, Bun, Node.js/npm                  |
| `bun run test:live`        | Real configured models, native TUI, synthetic materials            | Explicit live configuration and credentials |

Use `OPENCODE_BIN` to select the host executable. Integration tests isolate configuration, data and sessions in temporary directories; fixture providers run on loopback. Set `XCOSPAN_PUBLIC_WEB_TEST=1` to enable tests that contact public HTTP services.

The default `bun run test` runs only unit tests. Live tests incur provider usage and run only when explicitly invoked. CI runs unit tests and installed-package integration on Linux, macOS, and native Windows x64 with Node.js 22 and 24, without live credentials. Both npm and Bun installations exercise exports and native material extraction. Host/TUI integration runs against the npm-installed artifact. Workflow syntax is validated with actionlint and ShellCheck.

Use `bun run test:package --output dist/release` to retain a verified tarball and SHA-256 checksum. Use `--artifact /absolute/path/to/package.tgz` to test an existing artifact, including one downloaded from npm. See [Releasing](../docs/RELEASING.md) for workflow-based release validation.

## Live model configuration

Set `XCOSPAN_LIVE_CONFIG` to an untracked JSON file containing:

| Field        | Value                                            |
| ------------ | ------------------------------------------------ |
| `localModel` | Native `{ providerID, id }` reference            |
| `cloudModel` | Native `{ providerID, id }` reference            |
| `providers`  | Native provider definitions keyed by provider ID |
| `websearch`  | Native OpenCode search configuration             |

Each selected provider must have an explicit HTTP(S) `settings.baseURL`, its native `package`, and an entry in `models` for the selected model. Use OpenCode's environment-variable credential references; provide those variables to the test process. Model capabilities, limits and request `body` overrides come from this file. Tests compare actual requests with the selected model and configured body fields.

The test host exposes the selected models under the isolated role names `local` and `cloud`. Its recording proxy forwards native request headers and JSON bodies to the configured base address. Use HTTP providers with JSON model requests; provider-specific transports and OAuth flows require separate validation.

```sh
XCOSPAN_LIVE_CONFIG=/absolute/path/to/live-models.json bun run test:live
XCOSPAN_LIVE_CONFIG=/absolute/path/to/live-models.json bun run test:live --test-name-pattern "real quick start"
XCOSPAN_LIVE_CONFIG=/absolute/path/to/live-models.json bun run test:live --test-name-pattern "real sidebar"
```

In PowerShell, set the variable before running the same command:

```powershell
$env:XCOSPAN_LIVE_CONFIG = "C:\private\live-models.json"
bun run test:live --test-name-pattern "real quick start"
```

`XCOSPAN_PACKAGE` can point to an installed package directory to validate that artifact. Without it, live tests use the checkout. Configuration errors fail before starting the host.

Live artifacts are written to ignored `.local/live/`: request bodies, response streams, session records and terminal snapshots. They are diagnostic output and must be reviewed before sharing. Request authorization headers are not recorded. Never use private documents in automated live tests.

The quick-start journey runs the same `opencode plugin add` command as the README against an isolated registry serving the real npm tarball. It preserves existing provider configuration, selects and probes model roles in the native TUI, then enters four consecutive tasks in one session: local calculation, reviewed text collaboration, reviewed file collaboration, and another local calculation. It edits outbound revisions and approves reviews through terminal input, records each phase, and checks actual cloud requests and sensitive-content isolation.

The registry fixture serves package metadata and the exact tarball bytes; dependencies come from npm. `XCOSPAN_TARBALL` selects an existing artifact, and `test:package` passes its verified artifact automatically. Native installation coverage includes repeat installation, configuration preservation, update checks, updates, and removal. This fixture validates native installation behavior; public registry availability and publish authentication require a real publication.

To test installation from npm, set `XCOSPAN_INSTALL_SPEC` to a published package version or dist-tag:

```sh
XCOSPAN_INSTALL_SPEC=@iflytekopensource/opencode-xcospan \
  XCOSPAN_LIVE_CONFIG=/absolute/path/to/live-models.json \
  bun run test:live --test-name-pattern "real quick start"
```

This mode uses npm directly and fails if the requested package is unavailable. The Live models workflow exposes the same option as `install_spec`. Source registration is covered separately by the setup unit tests.

## Coverage

- Per-query routing, queued queries and return to local execution.
- Text/image review, editing, revision binding and complete outbound approval.
- Cloud context isolation and tool/network permissions.
- Streaming feedback, errors, retries and cancellation propagation.
- Restart recovery and single delivery.
- Model setup, lifecycle controls, concurrent edits and narrow/wide terminals.

Deterministic fixtures verify protocol and lifecycle behavior. Live tests additionally verify actual model interaction; analysis and redaction quality still require task-specific evaluation.

## Fixtures

`fixtures/materials/` contains synthetic document, spreadsheet, presentation, PDF, and scanned-image inputs. Unit tests execute the real extraction engine across these formats, plus text, HTML, CSV, JSON, RTF, and email. Regenerate the binary fixtures with:

```sh
uv run --with reportlab --with openpyxl --with python-docx --with python-pptx --with pillow test/fixtures/generate-materials.py
soffice --headless --convert-to doc --outdir test/fixtures/materials test/fixtures/materials/inspection.docx
```

The multi-file live test lets the model choose its local reading and calculation tools. The shipped extraction helper uses the installed Xberg native package. OCR tests need English Tesseract language data available to that engine. Exact workbook calculations need an appropriate local tool, such as Python with `openpyxl`. LibreOffice is used only to regenerate the legacy `.doc` test fixture.

`fixtures/boundary-probe/` tests extension permissions; `fixtures/delivery-barrier/` controls a crash point between completion and delivery. These are test-only plugins and are excluded from the published package.
