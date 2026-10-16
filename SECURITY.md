# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/XHToken/opencode-XCoSpan/security/advisories/new) when the repository offers that form. If it is unavailable, open an issue containing only a request for a private reporting channel. Share reproduction details after a maintainer supplies that channel. Keep exploit details and private materials out of public issues.

Security fixes target the latest published version. Include the affected version or commit, OpenCode version, operating system, and a minimal synthetic reproduction in each report.

## Data and execution boundaries

Originals, redaction comparisons, candidate revisions, and task associations are stored in local OpenCode plugin storage. These records can contain sensitive data and follow the OpenCode data directory's access and retention policies. Deleting a native conversation removes its associated review, run, and child-index records. Startup reconciles deletions made while XCoSpan was unloaded. Plugin removal retains records for subsequent reinstallation.

The plugin creates cloud sessions with an explicit model, approved task and materials, and scoped public-information tools. Their context excludes parent-session history and baseline workspace instructions. Delegation waits for approval before starting. Review RPC methods are not exposed as model tools.

The model selects materials and writes the delegated task. Redaction quality requires human review. The local model retains original context and can include identifying information when assembling a task. Complete-candidate review covers the objective, related context, materials, and expected output. The user checks, edits, and approves the actual outbound revision. Subsequent cloud requests include the delegated task's execution history and authorized tool results.

Native `webfetch` in a delegated session filters connections to public addresses. Literal IPs, resolved DNS addresses, and redirected connections are checked to block loopback, private, and link-local addresses. The implementation uses `request-filtering-agent` and Got, preserving native permission checks, content handling, and cancellation. `websearch` uses the host-configured search service. The deployment environment must govern that service and network behavior from other plugins or MCP servers.

The plugin controls sessions created through its delegation tool. The host and operating system govern the primary agent's shell, other plugins, MCP services, and external network permissions. Operating-system network isolation requires deployment-level controls.

Local-role capabilities use the configured local model by default. A remote provider receives the corresponding inputs. Optional routing and redaction HTTP services are restricted to loopback and cannot redirect.

User cancellation stops the associated native parent execution and its pending reviews. Cloud cancellation also waits for the native child session to stop. Historical cancelled records do not interrupt a later task. Interrupted runs with uncertain outcomes remain `unknown` for recovery checks. Recovery does not rerun cloud work. Exposing an unauthenticated OpenCode service or its local data directory can expose review RPC methods or sensitive materials; use host authentication and local access controls.

When reporting an issue, provide redacted reproduction steps, the OpenCode version, and relevant errors. Exclude credentials, original private documents, and complete private conversations.
