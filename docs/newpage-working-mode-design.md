# New page backgrounds: working modes (#377)

Interactive design and selection form: [New page working-mode mockups](scribe:newpage-working-mode-mockups), in Scribe's Design folder. The page holds the self-contained shaders and uses `scribe.reply` to deliver selections and freeform feedback to #377.

| Background | Working gesture |
| --- | --- |
| Nebula | Inward travelling highlights and a softly breathing core |
| Stardust | Sparkles stream inward and dissolve near the centre |
| Aurora curtains | A light wave travels across the vertical rays |
| Caustics | Outward water ripples refract and illuminate the net |
| Contour map | An outward pulse highlights existing height lines |
| Halftone | Concentric waves swell and brighten dots |
| Bokeh | Discs converge, dissolve and reappear at the edge |

The stage has an idle/working toggle with an eased intensity transition, a side-by-side comparison at the same time, text visibility, and pause. Gallery previews show working mode. The renderer shares one WebGL context, skips offscreen canvases and hidden documents, caps pixel density, and freezes time for reduced motion. Shader compile failures are displayed on the page.

## Validation

Scribe screenshots confirm all seven shaders draw and the comparison controls display both stages. Separate Playwright runtime checks could not run locally: the default Edge channel was missing, and loading the repository browser launcher via tsx hit a sandbox `spawn EPERM`. No full automated animation or form-submission validation is claimed. The form follows Scribe's documented card reply API, and no real feedback was submitted during checking.

## Implementation after selection

Read the choices posted on #377, then reread the current `public/newpage.js` before integrating. This worktree started with the original single Nebula implementation; the card describes a newer seven-background implementation. Keep the latest background selector and lifecycle wiring when adding selected gestures. Working must drive a separate eased intensity uniform, without increasing the shared drift clock. Preserve reduced motion, hidden-screen stops, theme support and fallback behavior.

The user selected Nebula, Aurora curtains and Contour map. These now ship in `public/newpage.js`, using an eased `u_work` uniform while the shared drift clock stays at its idle pace. The backdrop accepts `set(on, id, working)`; both normal rendering and Settings changes pass the current agent state. Reduced motion freezes the clock, applies the current working intensity immediately and reacts when the preference changes. Caustics' idle lighting is reduced to one fifth of its previous intensity, following the user's request for a very dim effect.

The seven-background prerequisite was present as commit `549fc1c` on the previous #377 branch but absent from master and this resumed worktree. It was cherry-picked here as `cacd09b`, preserving the Settings selector and random bag.

Unselected modes have fresh proposals in [Revised working-mode ideas](scribe:newpage-working-mode-revised): a constellation sweep for Stardust, a dim wandering underwater lens for Caustics, a broad diagonal wave or random colour droplets for Halftone, and independent focus blooms for Bokeh. Card #383 holds the pending selections in Needs input, and the page's form replies there. The original mockup remains available as the record of the first selections.

Validation after implementation: `npm run build`, `npm run test:newpage` (two lifecycle tests), `node --check public/newpage.js` and `git diff --check` passed. The lifecycle tests cover eased working transitions without speeding the clock, stopping while hidden, reduced-motion changes, and preserving working state across Settings changes. Scribe screenshots confirmed that all three exact production shaders and all five revised proposals draw. These screenshots establish rendering, not a full browser animation or form-submission test.

While creating this page, `page_read(toFile: true)` returned a temporary HTML checkout that Scribe `read_file` refused as outside its allowed roots. Reported separately as #379 in design; page_read line windows/full HTML remain a usable workaround.
