/**
 * Pages and templates written for Agent Board use `window.board`, `data-board-*` attributes and
 * the bridge's `board-*` classes. Scribe renamed them; this rewrites old HTML to the new names.
 * It runs on load and on import, and does nothing to HTML that is already up to date.
 *
 * The calls keep working as before: scribe.set still takes top-level keys, scribe.signal a name.
 */
const API = "state|set|signal|bind|onChange|open|resolve|agent|saveAsset|assetUrl|deleteAsset|listAssets|revision|template|reportIncompatible|flush|id";
const BOARD_CALL = new RegExp(`(^|[^\\w.$-])board\\.(${API})\\b`, "g");

export function upgradeLegacyHtml(html: string): string {
  if (!/board/.test(html)) {
    return html;
  }
  return html
    .replace(/\bwindow\.board\b/g, "window.scribe")
    .replace(BOARD_CALL, "$1scribe.$2")
    .replace(/\bdata-board-(signal|open|mode|autotitle|link-checked)\b/g, "data-scribe-$1")
    .replace(/\bboard-(stale|link-missing)\b/g, "scribe-$1");
}
