# Native in-app skills — #239
Updated 2026-10-11. Repository snapshot: 15f9f13. Design only; no skill manager implemented.

## Recommendation
Store reusable skills as ordinary SKILL.md folders owned by Scribe. Manage them in Agent settings, select them per thread or worker, and expose one consistent catalog across Claude, Cursor, Codex and Native.
Start with read-only MCP delivery plus a compact name/description index for all providers. Add native provider adapters where verified. Keep one canonical copy; do not write app skills into project repositories.

## Current state (verified in source)
| Provider | Existing integration | Composer commands |
|---|---|---|
| Claude | User/project/local settings in ordinary threads; user only in Pages mode. Skill tool available. Scribe has no app-skill plugin or skill filter wired. Hooks from settings/plugins are off by default; MCP servers come from Scribe's resolved list. | Provider command list supported. |
| Cursor | User/project settings in ordinary threads; no setting sources in Pages mode. No app skill path wired. | commands() returns []. |
| Codex | Runs with Scribe-owned CODEX_HOME: dataDir/agent/codex. Login is synchronized separately; this is not synchronization of the user's skill folders. No app-skill adapter wired. | commands() returns []. |
| Native (Pi) | DefaultResourceLoader uses workspace cwd and dataDir/agent/pi/agent. Extensions disabled; no additionalSkillPaths or skillsOverride wired. | Loaded skills exposed as /skill:name. |

Pages mode is the internal mode "board". A Kanban worker can run Code mode: being a worker is not itself what disables project setting sources.
The bundled scribe documentation is served by scribe_docs; it is not a general catalog. src/mcp.ts has no skill_list/skill_read management API.

## First version: user experience
- Agent settings → Skills: searchable list with name, trigger description, source, enabled state, and availability in the current provider/mode.
- New, edit, duplicate, import folder, export folder, and trash/restore for app-owned skills.
- Editor: trigger description, Markdown instructions and preview, supporting files. Validate frontmatter and show import contents before saving.
- External skills: view source and Copy to Scribe; initially no editing provider or repository files in place.
- Thread picker and worker picker use stable skill IDs. Show why a skill is unavailable (disabled, scope, provider or mode).
- First version scopes: explicitly enabled global skills, workspace assignments, thread selections and worker selections. Resolve workspace identity from the original checkout, not each temporary worktree path.
- Built-in Scribe documentation stays versioned with the app; offer a copy for customization while keeping current page/API rules discoverable.
- Defer ZIP import, agent writes, rich version history and sharing until basic folder support works.

## Storage and delivery
Canonical proposal: dataDir/skills/<id>/SKILL.md plus supporting files. DB metadata: stable id, display name, enabled flag, assignments, source/provenance and revision. Names can change without breaking worker selections.
Compute the effective catalog in one resolver. Deduplicate by ID; explicitly handle same-name external skills. Scope controls automatic discovery, not file access permissions.
MCP fallback (proposed, absent today): skill_list and skill_read(id, relativeFile?). Provide descriptions in the prompt and fetch bodies only when used. Enforce the thread's effective catalog and support-file boundary. Pages/Ask modes receive approved text/reference content through this API; scripts still require Code tools and the thread's permissions.
Native adapters:
- Claude: installed SDK types expose local plugins and skills filtering. Generate a skill-only plugin with selected folders; do not accidentally hide unrelated external skills with a global allowlist. Test namespacing, settings sources, resume and hook isolation.
- Pi: installed types expose additionalSkillPaths and skillsOverride. Supply selected folders while preserving existing workspace discovery according to the product choice.
- Cursor: installed local options expose dirs, which also load rules and other context. No dedicated local skill path found. Prefer MCP fallback initially; do not add an extra workspace root merely to transport skills.
- Codex: Scribe-owned CODEX_HOME gives a candidate materialization location, but no exact load/filter/reload contract is verified in this investigation. Probe the shipped app-server's discovery and session behavior before enabling native delivery. Keep MCP fallback available.

## Implementation checks before shipping
1. Catalog persistence, CRUD and atomic folder writes. Import validation, traversal and symlink containment; trash/restore and supporting file round trips.
2. One scope resolver for UI, prompt index, MCP reads and adapters. Disabled IDs remain meaningful in saved worker configurations.
3. Read-only MCP delivery with catalog-revision tracking. Freeze a revision per turn; apply edits on the next turn. Verify reconnect/resume without promising it preserves sessions yet.
4. Merge app entries into the existing composer menu independently of provider commands. Selecting a skill explicitly invokes it; enabling a skill only makes it discoverable.
5. Native adapter probes for discovery, collision handling, selection, resume, Pages/Ask/Code modes, and Code workers using worktrees.
6. A skill may refer to an MCP server absent from the thread. Show required capabilities in the editor; do not auto-connect servers or expand permissions.

## Decisions for the user
The linked Scribe page includes a persistent form and freeform notes:
- Storage: folder + metadata (recommended), database, or Library pages.
- Delivery: consistent MCP fallback first (recommended), or native adapters first.
- Initial scope: global + thread/worker selection (recommended), global only, or all scopes including workspace.
- External skills: read-only + Copy to Scribe (recommended), edit in place, or hide.
- Built-in: versioned/read-only and copyable (recommended), or keep current arrangement.

## Evidence
- src/agent/providers/claude.ts:646–717; sdk.d.ts:2027–2033 and 2255–2273.
- src/agent/providers/cursor.ts:565–566 and 660–674; @cursor/sdk/dist/esm/options.d.ts:158–162.
- src/agent/providers/codex.ts:68–74, 139–145 and 889–895.
- src/agent/providers/pi.ts:55–60, 511–517 and 798–810; Pi dist/core/resource-loader.d.ts:76,88.
- src/agent/providers/provider.ts:142; public/agent.js:4420; src/mcp.ts:656–662.
Local installed SDK declarations were inspected. Native delivery paths are proposals, not end-to-end validated support. No runtime adapter tests were run for this design-only change.

