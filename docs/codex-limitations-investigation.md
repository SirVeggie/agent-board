# Codex limitations: second investigation

Card #276 · 9 October 2026 · Investigation only

Scribe report and decision form: `scribe:codex-limitations-276-investigation` (Design folder). Permission visibility follow-up: card #277.

## Recommendation

Prototype an app-server adapter for interactive Codex sessions in Scribe. Keep the TypeScript SDK for batch jobs if useful. The reported SDK limitations are real, but Codex itself exposes richer interfaces. Keep Scribe's limited-web gate separate from command networking.

## Evidence in this checkout

- `package.json` requests `@openai/codex-sdk ^0.162.0`; the installed SDK is 0.162.0 and its dependency is `@openai/codex 0.162.0`. The bundled CLI reports `codex-cli 0.162.0`.
- `src/agent/providers/codex.ts`, `sandboxFor` and `threadOptions`: Ask, Plan, and Pages use read-only; Code uses workspace-write unless Full access is selected; approval policy is always never. Off and Limited disable built-in web search and command network access.
- `CodexSession.run` rejects adoption of steered input; the provider does not implement `steer`. `src/agent/providers/provider.ts` already defines approval handling and optional steering interfaces.
- Installed SDK `dist/index.js` starts `exec --experimental-json`, writes the input, and closes stdin. Installed type declarations expose approval configuration, but no callback or steering method.
- Generated TypeScript protocol bindings from the installed CLI include `turn/steer`, `turn/interrupt`, command/file approval requests, permission approval requests, and user-input requests. `TurnSteerParams` requires an active `expectedTurnId`. Thus these capabilities are present in this bundled runtime's schema, not merely in newer documentation.
- Scribe already launches app-server briefly to discover models. Its helper handles outgoing request responses, not incoming approval requests or streamed turn notifications; it is not a complete session client.

## Rechecking the four limitations

| Reported limitation | Finding | Consequence |
| --- | --- | --- |
| SDK has no approval callback | Confirmed in installed TypeScript SDK. Setting approvalPolicy changes configuration, not the communication channel. | Switching the enum alone cannot wire Scribe's dialogs. |
| Ask / Plan / Pages must use read-only | This is Scribe's current mapping. Local filesystem policy and page/tool permissions are separate. | Keep intentional read-only boundaries; enforce page mutation and plan behavior separately. |
| Code cannot ask; Full access removes sandbox | Never-ask is the adapter's choice to accommodate the SDK. Full access really does bypass sandboxing. | An interactive interface can retain a bounded workspace and handle approval requests. |
| Web Limited has no gated allowlist fetch | The adapter disables native search and command networking for Limited. Current command filtering does not encompass hosted search or MCP. | Use host-controlled web tools for Scribe's allowlist. |
| Messages wait for next turn | Confirmed for this adapter and SDK. | App-server offers active-turn steering; cancellation/resume is only a workaround. |

## What the CLI and app-server add

The interactive CLI supports command approval prompts and active-turn steering. It offers an immediate manual alternative. Driving its terminal UI by parsing prompts would be fragile for an embedded Scribe client. [CLI features](https://learn.chatgpt.com/docs/codex/cli), [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

App-server is intended for rich clients. It provides server-initiated command/file approval requests and decision replies, permission requests, user-input requests, streamed turn events, and thread lifecycle operations. `turn/steer` appends input to an active turn, requires `expectedTurnId`, fails without an active turn, and cannot change turn configuration. `turn/interrupt` cancels. Start with local stdio, initialize the connection, then start/resume a thread. Generate schemas from the deployed binary. The command is experimental; use version pinning and compatibility checks. [App-server protocol](https://learn.chatgpt.com/docs/app-server).

Inference: these provide the building blocks for Scribe's missing UX. Accepting active-turn input does not promise an already-running external command stops immediately. Scribe must handle completion races and distinguish accepted input from input actually consumed by the model.

## Permissions and web policy

Sandbox and approvals are separate controls. Workspace-write with on-request approval is supported; routine actions within the allowed workspace need not prompt individually. Native Windows and WSL use different sandbox implementations. Verify each supported environment rather than equating approval mode with filesystem enforcement. [Sandbox documentation](https://learn.chatgpt.com/docs/sandboxing).

Beta permission profiles can express filesystem and network access more precisely. They do not compose with legacy sandbox settings: passing a sandbox flag can select the legacy path. The current SDK supplies that flag when sandboxMode is set. MCP uses its own transport and controls; a read-only local filesystem does not make Scribe page operations read-only. [Permission profiles](https://learn.chatgpt.com/docs/permissions).

Command-domain filtering requires network permission and active proxy enforcement. Domain rules alone do not activate the proxy. Network enabled with proxy disabled permits direct outbound access. The command proxy does not filter hosted search or MCP. Cached search still uses an external index and is not Web off. [Network isolation](https://learn.chatgpt.com/docs/agent-approvals-security).

Proposed Scribe mapping: disable native web search for Off and Limited. For Limited, expose host-controlled fetch/search tools that enforce Scribe's allowlist, redirects, and destination resolution. Keep alternative command networking disabled unless an enforced destination policy is intentionally configured. Page mode needs Scribe's page gates; Plan needs planning behavior as well as filesystem restrictions.

## Alternatives

| Approach | Benefit | Cost / fit |
| --- | --- | --- |
| App-server adapter | Structured approvals, steering, events; verified in installed schema | Preferred prototype. Implement bidirectional RPC and lifecycle handling. |
| Retain TypeScript SDK | Smallest change; useful for unattended jobs | Document missing native interaction. Host-gated MCP tools can improve web/pages but cannot add native steering. |
| Interactive CLI | Existing terminal approval and steering UX | Manual escape hatch; terminal prompt scraping is unsuitable for Scribe dialogs. |
| Python SDK sidecar | Current official SDK controls app-server and includes a pinned runtime | Extra process/language; inspect callback surface before assuming parity. |
| Custom model API agent | Scribe owns tool execution and gates | Different architecture, auth/billing and substantial agent-loop work; not a drop-in Codex replacement. |

Current official SDK guidance distinguishes batch SDK usage from app-server clients, documents the Python app-server SDK, and says the old `codex mcp-server` integration was removed. [SDK documentation](https://learn.chatgpt.com/docs/codex-sdk).

## Acceptance checks for a follow-up prototype

1. Pin CLI version and generate schemas; reject unsupported protocol variants clearly.
2. Handle command/file approval accept, decline, cancellation, session scope, and pending-request cleanup.
3. Bridge steering to Scribe's existing delivery accounting. Queue exactly once when a turn completes before steering succeeds; verify consumed versus accepted input.
4. Verify shell, filesystem, page mutation, and Plan boundaries independently.
5. Check Off and Limited through all enabled web paths, including redirects and denied destinations.
6. Verify native Windows execution, thread resume, interruption, and process restart recovery.

## Observed Scribe limitation

The initial worker session's effective policy was read-only with approvals never despite the Code task context. Shell reads and MCP page/board actions were rejected, preventing report creation and card hand-in. The user changed permissions and the same operations then succeeded. The cause of that initial policy selection has not been established. Record a design issue to expose effective worker permissions and detect incompatible settings before launch, preserving the user's chosen boundaries.

## Validation and scope

Reviewed official documentation, local adapter and provider interfaces, installed SDK code/types, package versions, bundled CLI help, and generated app-server schemas. No model turn or live approval/steering execution was run. This establishes interface availability, not end-to-end correctness. No production implementation was changed. The decision is whether to schedule an app-server prototype or retain the SDK's documented limitations.
