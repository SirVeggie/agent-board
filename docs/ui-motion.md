# Shell motion and paint

Use `--dur-*` for timing and `--z-*` for stacking. The shell currently has a zero backdrop-blur budget (`--blur-none`); use theme backgrounds for panels and repeated cards.

Pane geometry changes immediately. Animate only transform and opacity on live iframe surfaces. Do not interpolate width, height, margins, or offsets, or blur the workspace during a transition.

Load `motion.js` before shell components. Use `scribeMotion.reveal(node, visible, options)` for entry and exit, and its `finished` promise for cleanup. `scribeMotion.animate` supports position changes with transform keyframes. Timing comes from CSS tokens. New transcript and dock rows call `scribeMotion.enter` once on insertion; its attribute clears on animation end or cancellation. Simple CSS-only overlays use `@starting-style` with an opacity transition.

`html.fx-off` and reduced motion apply to the whole shell. CSS effects pause or stop, and the helper finishes in-flight finite animations so exit cleanup still runs. JavaScript effects listen to `scribe:ui-fx`. Infinite activity effects use transform or opacity and should only run while visible.

Button defaults belong to the `reset` cascade layer. Component selectors do not need a `button` prefix to override them.
