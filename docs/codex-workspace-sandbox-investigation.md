# Codex workspace-write investigation (#283)

Investigated on Windows, 9 October 2026, using installed Codex CLI 0.162.0.

## Finding

The configuration trigger is an unselected Windows sandbox implementation.
Scribe requests `workspace-write` but its isolated `CODEX_HOME` has no Windows
sandbox selection. Setting `windows.sandbox` per request changes the returned
policy to `workspaceWrite`. These overrides were confined to probe threads;
neither the user's configuration nor Scribe's production mapping was changed.

| thread/start configuration | Reviewer | Returned sandbox |
| --- | --- | --- |
| No Windows sandbox setting | user | readOnly |
| No Windows sandbox setting | auto_review | readOnly |
| windows.sandbox = unelevated | user | workspaceWrite |
| windows.sandbox = unelevated | auto_review | workspaceWrite |
| windows.sandbox = elevated | user | workspaceWrite |
| features.experimental_windows_sandbox = true | user | workspaceWrite |
| danger-full-access control | user | dangerFullAccess |

The matrix reproduced with the inherited Scribe Codex home and a newly created
scratch home without user configuration or authentication. The scratch home also
returned `readOnly` for a durable baseline thread. This rules out ephemeral
threads and the approval reviewer as necessary causes of this reproduction.

The legacy feature flag is recorded as diagnostic evidence, not recommended as
an integration setting. The documented `windows.sandbox` key is preferable.

## Scribe path

- `src/agent/providers/codex.ts`: `cliEnv` selects Scribe's isolated Codex home;
  `syncCodexAuth` copies authentication only, not the user's configuration.
- `sandboxFor` maps Code mode to `workspace-write` except Full access.
- `threadOptions` does not select a Windows sandbox implementation.
- The session consumes thread identity from thread/start or thread/resume but
  does not display the response's effective sandbox policy to the user.

## Reproduce

```powershell
node node_modules/@openai/codex/bin/codex.js --version
node --import tsx tools/probe-codex-sandbox.ts
node --import tsx tools/probe-codex-sandbox.ts --scratch-home
```

The probe sends initialize and thread/start only, disables web search, and does
not send turn/start. Normal runs create ephemeral threads. The scratch option
creates a temporary Codex home and adds a durable control there; it leaves that
directory for inspection. It prints only policy fields, not credentials,
thread contents, or complete configuration. It uses the inherited CODEX_HOME;
run from Scribe to test its configuration, or explicitly select another home.

## Limits and proposed follow-up

No model turn, sandbox command, ACL change, elevated setup, or configuration
write was performed. A returned workspaceWrite policy alone does not establish
that elevated setup is provisioned or that command execution succeeds. MXC
compatibility was not tested. No broader claim about all Windows versions or
CLI versions follows from this matrix.

Proposed integration: retain the effective sandbox from thread/start and
thread/resume, show a mismatch with the requested policy, and guide Windows
users through selecting and verifying a supported sandbox implementation.
Do not silently switch to Full access or copy the entire personal config.
Implementation remains a separate choice after this investigation.

Official OpenAI documentation describes Windows sandbox selection separately
from filesystem policy, elevated provisioning for a specific CODEX_HOME, and
the weaker network isolation of unelevated mode:

- https://learn.chatgpt.com/docs/windows/windows-sandbox
- https://learn.chatgpt.com/docs/config-file/config-basic

The exact downgrade trigger above is a local experimental finding, not a quoted
guarantee from the documentation.
