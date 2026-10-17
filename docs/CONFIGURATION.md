# Configuration and capability services

## Models and scope

Install through the [Quick start](../README.md#quick-start), then enter `/xcospan` in OpenCode and choose **Configure models** to select the local-role and cloud models. The interface reads OpenCode's model catalog, supports account connections and custom services, and can check each model's connection and tool-calling support. Checks incur actual provider usage and can be cancelled.

Settings are saved to the selected OpenCode JSON / JSONC source, preserving unrelated values and comments. Concurrent changes require a reload. Stop active tasks before changing models. Saving preserves the current default agent; users can explicitly choose XCoSpan as the default for new sessions.

Plugin options for manual configuration:

| Field                          | Meaning                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `localModel`                   | Required `{ providerID, id }` reference for the local role                             |
| `cloudModel`                   | Required `{ providerID, id }` reference for cloud collaboration                        |
| `enabled`                      | Optional; `false` disables collaboration while keeping management available            |
| `routeURL`                     | Optional local routing service URL                                                     |
| `redactURL`                    | Optional local redaction service URL; required for image redaction                     |
| `routeKeyEnv` / `redactKeyEnv` | Optional environment variable names containing service Bearer credentials              |
| `timeoutMs`                    | Optional positive integer timeout in milliseconds for routing and redaction HTTP calls |

The management interface saves `previousDefaultAgent` to restore the previous default.

OpenCode provider configuration controls API addresses, protocols, accounts, tool capabilities, context windows, and output limits. Model choices come from configuration. Environment variables must reach the OpenCode service that makes requests; see the [provider environment documentation](https://opencode.ai/v2/docs/cli/providers#environment).

## Material tools

The bundled `xcospan-materials` Skill runs its extraction helper with Bun. Keep Bun 1.4.3 on the OpenCode process's PATH. The npm package includes the helper and its Xberg dependency. OCR additionally requires local Tesseract language data for the languages selected by the task; exact spreadsheet calculations require an available spreadsheet-capable tool. These tool dependencies are separate from model account configuration.

## Routing

Each new query is routed before the local model's first call. Subsequent tool rounds reuse that decision. Routing uses the selected local-role model by default, or `routeURL` when configured.

```text
POST routeURL
{
  query: string,
  context: SessionMessageInfo[],
  files: SessionMessageUser["files"],
  capabilities: {
    localModel: { providerID: string, id: string },
    cloudModel: { providerID: string, id: string },
    tools: { name: string, description: string }[],
    skills: { name: string, description?: string }[]
  }
}
-> { reason: string, route: 0 | 1 }
```

`context` contains native session messages preceding the current query. `files` contains the current user message's native attachment descriptions. Their fields follow the supported OpenCode SDK types. `capabilities` is collected from the current host tool set, Skill discovery, and configured model roles; routing evaluates the task against that available setup.

`route=0` selects local execution; `route=1` selects cloud collaboration. The plugin maps this strict algorithm result to its internal `cloud` flag for session state and execution. The local model selects materials, preparation steps, and delegation content from the task and context.

## Redaction

Text redaction uses the selected local-role model by default. The local model uses the `xcospan-materials` Skill and suitable local tools to select and extract the content needed for the task before redaction. When `redactURL` is configured, that service handles text and images and the plugin registers `redact_image`. Available tools and routing inputs reflect this configuration.

```text
POST redactURL
{ content: Content }
-> { content: Content, changes: string }

Content =
  { type: "text", text: string }
  | { type: "image", mime: "image/png" | "image/jpeg" | "image/webp", data: string }
```

Image `data` contains the complete base64-encoded bytes. Output preserves the input content type. `changes` describes the transformation. The user reviews service output before it can be delegated.

Both service URLs must use loopback addresses; redirects are rejected. Errors surface directly, and cancellation reaches the request. Originals, candidates, change descriptions, and approved revisions are stored in OpenCode plugin storage.

## Built-in algorithm policy

Routing evaluates the current query and session context against the configured model and available tools. The decision considers the complete deliverable, required reasoning, and a verification path. Model identity, file format, domain, and task length are assessed within those requirements. Invalid JSON or an invalid decision stops the request.

Text redaction covers direct and indirect identifiers, credentials, business entities, financial and contractual data, and identifying combinations. This policy includes contract amounts, payment percentages, and liability percentages. Every candidate is shown against its original; users can edit the candidate to retain facts needed for the delegated task. The local agent uses the reviewed version when preparing the final outbound task.

Built-in text redaction sends the input to the configured local-role model and returns a complete text candidate. The sensitive-data categories follow Privacy Gateway's `string_only` policy at revision `6256c66fb869b40959d75cbfa29a3d4864294228`. External redaction engines integrate through the HTTP service contract above.

Users review each model-generated candidate for sensitive-data coverage, document structure, and placeholder consistency. The original and approved candidate remain in plugin storage for comparison. The plugin requires material review and approval of the complete outbound task before cloud execution.

## Review and outbound content

`redact` / `redact_image` return the approved material's review ID. `cloud_delegate` accepts `reviewIds`: the reviewed text handoff first, then approved supporting materials. The handoff contains the objective, relevant context, constraints, and requested output. The plugin assembles these approved contents into the complete candidate for final editing and confirmation. New model-authored instructions require a new material review.

Each save creates a new revision. Approval of the complete candidate starts the cloud task. Failure, rejection, or cancellation stops the pending send. Subsequent cloud requests include the approved task, its own execution history, and authorized tool results.

## Disable, remove, and recover

- Use `/xcospan` to stop the current task, return to the previous agent, or disable / enable collaboration.
- Removal acts on the selected configuration source. Check `/plugins` for other loading sources.
- After host interruption, reviews with a lost caller become `interrupted`. Runs whose outcome cannot be confirmed become `unknown`.
- Persistent associations recover delivery of completed cloud results. Repeated recovery is idempotent.

See [SECURITY.md](../SECURITY.md) for data-access and deployment boundaries.

## Routing conversation context

Each new user query receives its own routing decision. Tool rounds within that query reuse the decision. The router receives the complete current query and up to three recent user turns, with the user text and last assistant text from each turn. Each historical entry contains at most 600 Unicode characters and a `truncated` flag. Historical tool output and reasoning are omitted. Current attachments and the available capability descriptions accompany the query. The parent agent keeps its full native context.
