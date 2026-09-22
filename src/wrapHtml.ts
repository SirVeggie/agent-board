export const BOARD_SCROLLBAR_CSS = `
html { scrollbar-width: thin; scrollbar-color: rgba(127, 127, 127, 0.45) transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(127, 127, 127, 0.45) transparent; }
::-webkit-scrollbar { width: 5px; height: 5px; background: transparent; }
::-webkit-scrollbar-track,
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(127, 127, 127, 0.45); border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: rgba(127, 127, 127, 0.65); }
`.trim();

const DEFAULT_CSS = `
:root {
  color-scheme: dark;
  --bg: #1a1a1d;
  --text: #e8e8ea;
  --muted: #8e8e96;
  --border: rgba(255, 255, 255, 0.08);
  --accent: #c9c9d0;
  --code-bg: #131315;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.55;
  font-size: 15px;
  padding: 34px 44px 72px;
  max-width: 980px;
  margin: 0 auto;
}
h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; }
h1 { font-size: 1.7rem; margin: 0 0 0.8rem; letter-spacing: -0.02em; }
h2 { font-size: 1.25rem; margin: 1.6rem 0 0.6rem; }
h3 { font-size: 1.05rem; margin: 1.3rem 0 0.45rem; }
p, ul, ol { margin: 0.65rem 0; }
ul, ol { padding-left: 1.3rem; }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--border); margin: 1.5rem 0; }
code, kbd {
  font-family: "Cascadia Code", Consolas, monospace;
  font-size: 0.9em;
  background: var(--code-bg);
  padding: 0.1em 0.35em;
  border-radius: 6px;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  padding: 12px 14px;
  overflow: auto;
  border-radius: 12px;
}
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0.8rem 0 1.2rem; font-size: 0.95rem; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: rgba(255, 255, 255, 0.04); font-weight: 600; }
blockquote {
  margin: 0.8rem 0;
  padding: 0.2rem 0.9rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
}
.muted { color: var(--muted); }
${BOARD_SCROLLBAR_CSS}
`.trim();

export function wrapHtml(title: string, html: string): string {
  const trimmed = html.trim();
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return html;
  }
  const safeTitle = escapeHtml(title || "Untitled");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${DEFAULT_CSS}</style>
</head>
<body>
${html}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
