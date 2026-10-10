# Refresh/startup investigation (#418)

Measured 2026-10-10 against the running daemon, using a separate headless Brave
Chromium at 1280×800. The probe creates fresh browser storage for each scenario,
then performs an initial navigation and two reloads. It records WebGL setup,
long tasks, WebSocket milestones, and tab DOM restoration. It does not modify
application code or settings. Raw observations: `startup-profile-418.jsonl`.

## Findings

Synchronous graphics initialization is the largest measured startup cost.
The initial navigation restored the tab DOM at **2357 ms**, while the probe
with `scribeGL.create` returning null restored it at **231 ms**. Normal reloads
restored it at **214 and 494 ms**; the no-WebGL reloads took **79 and 72 ms**.
These are diagnostic samples, not a promised speedup: scenarios ran in sequence,
share a browser process, and have different cache histories. The baseline first
navigation's shader caches were not explicitly cleared. Normal reload variation
also shows that the cost is not exclusively a first-launch problem.

| Milestone from navigation | Normal initial | No-WebGL initial |
| --- | ---: | ---: |
| Shell HTML response complete | 4 ms | 6 ms |
| WebSocket constructed | 566 ms | 163 ms |
| WebSocket open callback | 600 ms | 187 ms |
| Snapshot message callback | 1890 ms | 203 ms |
| Tab DOM restored | 2357 ms | 231 ms |

The connection was already open before the large orb initialization. Its snapshot
callback could not run while the main thread was blocked. This is not evidence
that the server spent 1.3 seconds constructing the snapshot.

The initial normal load called `scribeGL.create` eight times, totaling about
**2217 ms** of synchronous setup. Six canvases had no layout size at creation:

| Effect | Setup time | No layout size? |
| --- | ---: | --- |
| Title bar wash | 183 ms | No |
| New page nebula | 234 ms | Yes |
| Dock orb | 1195 ms | Yes |
| Dock orb spill | 12 ms | Yes |
| Three star effects | 438 + 45 + 5 ms | Yes |
| Aurora edge | 106 ms | No |

`public/glfx.js:14` creates contexts and compiles/links shaders synchronously,
checking compile/link status immediately. Timings include context creation,
compilation, driver synchronization, and setup; the probe does not isolate each.
`chromefx.js:156` initializes before `app.js` runs. `newpage.js:273,310` compiles
the nebula even when New page is hidden. `orb.js:180` creates two effects during
chat mounting. `starfx.js:96` compiles effects during UI construction.

Long tasks on the initial normal load were 216, 245, 1216, 68, 467, and 174 ms.
No long tasks were observed in the three no-WebGL samples during the measurement
window. Driver/GPU contention from shader compilation is a plausible explanation
for other browser windows stuttering. This probe did not measure a YouTube window
or GPU process, so that cross-window attribution remains an inference.

## Why the app looks empty

`public/index.html:104` visibly renders “Waiting for a page” before scripts run.
`app.js:188` begins with empty tabs and no active page. The WebSocket is started
at the end of `app.js`; only its snapshot handler (`app.js:494`) fills tabs and
spaces and calls render. Thus the UI shows the true-empty state while it is
still restoring saved data. Changing this appearance requires a distinct
restoring state, not simply hiding every empty screen.

The snapshot contained 8 open tabs, 122 closed pages, and about 75k characters.
`store.snapshot()` sends metadata, not every page's full HTML or state. The shell
creates frames for visible panes through `views.layout()`; it does not eagerly
load all 130 library pages. Full page loading is a subsequent stage.

## Other costs

Every measured load requested agent config, threads, browsers, and models twice:
`agent.js:488` loads them on connection, and `agent.js:9455` loads them during
boot. Threads alone were ~447 KB per response (~895 KB across the two calls).
Model completions trigger repeated renders. Existing design card #365 covers
deduplication and static serving improvements; #363 covers shader startup.

Google Fonts CSS is render blocking (`index.html:10`) even with font-display
swap. Initial requests here took ~92–107 ms. Offline or slow access could be
worse. Self-hosting the font or loading its CSS outside the critical path would
remove that external dependency. Key shell resources explicitly use no-store
(`http.ts:1863`); several large JS files and highlight.js are fetched again on
reload. Caching needs a reliable version/content hash invalidation scheme.

## Recommended mitigation order

1. Lazy-create hidden orb, New page, and star effects only when visible. Restore
   tabs first and use CSS visuals until effects are ready. Merely postponing all
   compilation by a timer moves the long stall later. If needed, investigate
   parallel shader compilation and a smaller orb shader.
2. Show a stable restoring shell until the first snapshot is applied. Display
   the empty page only after successful restoration confirms no selected page.
   Add connection failure/retry behavior so loading cannot remain indefinite
   (new design card #419).
3. Deduplicate startup requests and renders (#365); cache/version static assets
   and remove the external font stylesheet from the critical path.
4. Re-profile desktop WebView2 and a normal browser with the user's actual space,
   chat visibility, graphics settings, and a playing video. Capture GPU activity
   to confirm cross-window contention. Validate both initial load and reload.

## Reproduction and limits

```powershell
$env:PROFILE_BROWSER = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
node tools/profile-startup.mjs http://127.0.0.1:4747 3 |
  Out-File -Encoding utf8 startup-profile.jsonl
```

PROFILE_BROWSER is optional when Edge or Chrome is installed in a recognized
location. The normal scenario preserves default settings; no-WebGL is an
instrumentation control, not an existing UI setting. The probe reads the daemon's
served code, so rebuild/restart the daemon before profiling changed code.

The selected iframe returned HTTP 403 in this fresh browser context. Its load
event is therefore not a successful page-content measurement. Reported tab
times measure DOM restoration, not page readiness or first composited paint.
The desktop app was not profiled. Initial HTTP interception experiments could
not connect WebSocket; their timings were excluded from the final dataset.
Browser and contexts are closed on exit; content-origin authorization was not
bypassed. No production behavior changes were made.

## Implementation after approval

The user requested the recommended fixes on #418. Implemented:

- Graphics handles are lazy: hidden canvases open no WebGL contexts. Shown
  effects wait until the snapshot is applied and the restored shell can paint.
  CSS visuals remain until the shader is ready. Closing an effect cancels queued
  initialization and releases any compilation already underway.
- Visible shaders use `KHR_parallel_shader_compile` where supported, polling
  completion before reading link status. Unsupported browsers retain synchronous
  compilation, limited to effects actually shown after restoration. See the
  [Khronos extension specification](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/).
- The initial view says “Restoring your pages…” until saved tabs arrive. A slow
  or unavailable connection retries automatically and offers Retry connection.
  The empty page appears only after a successful snapshot confirms no selection.
- Boot and connection share agent startup data. Model requests still run in
  parallel, but their results trigger one render rather than one per provider.
- Shell asset URLs receive content hashes. Matching versions are cached as
  immutable; unversioned/old versions revalidate. HTML stays no-store so changed
  bytes produce new URLs. JS/CSS and vendor bundles are gzip-compressed.
- Google Fonts CSS is preloaded and applied after download rather than blocking
  the shell's first render. Existing font selection and fallback remain.

Final six-sample probe against an isolated, sanitized copy of the live data:

| Tab DOM restoration | Normal | WebGL skipped |
| --- | ---: | ---: |
| Initial navigation | 201 ms | 175 ms |
| Reload 1 | 69 ms | 87 ms |
| Reload 2 | 54 ms | 53 ms |

The initial normal sample initialized four visible effects and no hidden ones.
Its only observed long task was 63 ms. Orb shaders took approximately 1.5 seconds
to become ready asynchronously, with initialization calls themselves taking
10–12 ms. Initial context creation for the title bar still took 59 ms. GPU work
is reduced and no longer synchronously awaited where the extension is supported;
GPU contention with video and desktop WebView2 remain to be measured.

Raw data: `startup-profile-418-after.jsonl`. The copied database was newer than
the original investigation's dataset and both runs share browser-process caches;
these observations are not a controlled benchmark or guaranteed speedup.
The selected page again returned 403 in a fresh profile, so reported times remain
tab DOM restoration rather than page-content readiness.

Validation: TypeScript build, lazy/cancelled/failed graphics browser tests, restoring
screen timeout and retry recovery, static caching/version invalidation/compression,
orb animation/settings/fallback lifecycle, New page transitions/palettes/reduced
motion, and split/peek pane regression tests passed. New page was also opened in
the scratch browser and its shader and template choices appeared correctly.
