import fs from "node:fs";

/** Template fixtures with a stubbed scribe API still need the controller normally supplied by the bridge. */
export function templateHtml(name: string): string {
  const html = fs.readFileSync(new URL(`../../templates/builtin/${name}.html`, import.meta.url), "utf8");
  const drag = fs.readFileSync(new URL("../../public/pointer-drag.js", import.meta.url), "utf8");
  return html.replace("<head>", `<head><script>${drag}</script>`);
}
