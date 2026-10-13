# Transitions affected by #435

Inventory of the motion changes in `0bf898a` and `990a1fb`, compared with `0bf898a^`. This describes that change; later work can modify individual effects.

## Restored by #588

- Tab-strip agent button: restored the rotating conic-gradient border light. The sparkle still uses the new opacity breathing effect instead of an animated drop shadow.
- Space selection screen: restored workspace scale to 0.97 and blur to 6px, 220ms fade and 260ms scale/blur, CSS overview fade, staggered card entrance, and 300ms close cleanup. Effects-off and reduced motion remain supported.

## Other changes to motion or behavior

| Surface | Before #435 | Change in #435 |
| --- | --- | --- |
| Split panes opening/closing | Animated iframe position and dimensions | Geometry snaps; position animates with transform, new panes still fade/slide |
| Library and agent side panes | Width and margins animated over 280ms, opacity over 200ms | Width/margins snap; opacity uses 240ms |
| Settings dialog | 12px slide plus scale from .98; 180ms entry / 140ms exit | Shared 6px slide, no scale; 240ms entry / 160ms exit |
| Settings category sizing | Height transitioned over 220ms | Height snaps |
| Peek card entry | 6px slide and scale from .99 over 160ms | Opacity-only entry over 240ms; exit still uses slide/scale with the shared helper |
| Peek scrim | 160ms entry fade | 240ms entry fade |
| Library drag ghost | 120ms fade and scale from .92 | 240ms opacity-only entry; landing 160ms becomes 150ms |
| Full-window agent chat and modals | Fade plus 6px upward entrance (160–180ms) | Opacity-only entry over 240ms; agent menus had no such entry animation |
| Agent flyouts | 4px slide up/down plus 160ms fade | Opacity-only entry over 240ms |
| Agent toasts | 12px horizontal slide plus 220ms fade | Opacity-only entry over 240ms |
| Transcript rows | Per-item 240ms entry tracked across rebuilds, custom easing | Explicit one-shot shared entry with shell easing and attribute cleanup |
| Floating chat feed rows | 250ms fade/slide; existing rows lifted over 360ms with custom easing | Shared 240ms entry; existing rows lifted over 420ms with shell easing; fades use animation completion cleanup |
| Floating chat handle text | 12px slide with blur over 520ms, retargetable CSS transitions | Shared 6px slide, no blur, 240ms entry / 160ms exit |
| New-page screen entry and page handoff | 420ms fade with blur | 420ms fade without blur |
| New-page prompt / intent panels | 420ms fade with blur | Same fade timing, blur removed |
| New-page rotating intent words | 520ms fade, 8px slide and blur | 420ms fade with 6px slide, no blur |
| Refresh overlay dismissal | 220ms CSS fade with timer cleanup | 160ms shared exit fade with animation completion cleanup |
| Shell effects switch | CSS effects continued despite UI effects being off | CSS and JS effects obey a shared `fx-off` switch; reduced motion consolidated |

## Timing changes and ongoing activity effects

- Common 120ms hover/fade transitions became 150ms; 150ms transitions kept their timing.
- Tab reorder: 160ms → 150ms. Tab filing: 180ms → 240ms. Tab drag transforms/fades: 120ms → 150ms.
- Expandable built-in groups and agent queue dock: 220ms → 240ms.
- Context meter: 300ms → 420ms. Dock sweep visibility: 300ms → 420ms. Responsive pane opacity: 400ms → 420ms.
- New-page shader reveal and fallback fade: 320ms → 420ms.
- New-page grain shimmer: 1.2s → 1.6s; intent sheen: 2.6s → 2.4s.
- Refresh-overlay breathing line: 1.4s → 1.6s; palette busy effect: 1.2s → 1.6s.
- Several agent status/activity pulses: 1.2s → 1.6s. Shimmer became an opacity pulse; dock glow changed from animated shadow to opacity.
- Existing 90ms drop indicators, 700ms flashes, 800ms spinners, 900ms fades, and slow ambient rotation/drift timings were tokenized without changing duration.

## Related paint changes

Backdrop blur was removed from chrome, settings, template lock, new-page template cards, peek/file-preview scrims, floating chat output/handle, and agent modal backdrop. These are appearance changes rather than separate transitions.

## Selected restorations after review

Restored the handle's original retargetable 520ms slide/blur, settings slide/scale, peek slide/scale, full-window chat slide, modal/flyout/toast slides, and new-page entry/handoff/panel/word blur. Settings, peek, toast, flyout and modal timings retain the post-#435 values. Full-window chat retains the original 180ms timing; intent words retain the original 520ms timing. The review's "Agent menus" illustration was mislabeled: it represents full-window chat, not menus.

Transcript easing and rebuild behavior remain unchanged; rebuild continuity was left undecided. All explicit Keep choices, including backdrop blur removal and shared effects-off policy, remain in place.
