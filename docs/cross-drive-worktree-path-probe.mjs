// Read-only model of SvelteKit 2.55.0's SSR component-entry classification.
// Run on any OS: node docs/cross-drive-worktree-path-probe.mjs
import assert from 'node:assert/strict';
import { win32 as paths } from 'node:path';

const dependency = 'Library/Projects/llm-chat/node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte';
const cases = [
  { layout: 'cross-drive shared dependencies', drive: 'S:', fallback: false },
  { layout: 'same-drive shared dependencies', drive: 'C:', fallback: true },
  { layout: 'isolated dependencies', drive: 'C:', fallback: true, local: true },
];

for (const item of cases) {
  const routes = 'C:/worktrees/demo/src/routes';
  const component = item.local
    ? 'C:/worktrees/demo/node_modules/@sveltejs/kit/src/runtime/components/svelte-5/error.svelte'
    : `${item.drive}/${dependency}`;
  const relative = paths.relative(routes, component);
  const fallback = relative.startsWith('..');
  const entry = paths.join(
    fallback ? 'entries/fallbacks' : 'entries/pages',
    fallback ? paths.basename(component) : relative.replace(/\.js$/, ''),
  ).replaceAll('\\', '/');
  // Model only the colon replacement relevant to this observed filename.
  const sanitized = entry.replaceAll(':', '_');
  assert.equal(fallback, item.fallback);
  assert.equal(sanitized.startsWith('./'), !fallback);
  if (fallback) assert.equal(sanitized, 'entries/fallbacks/error.svelte');
  console.log(JSON.stringify({ layout: item.layout, relative, absolute: paths.isAbsolute(relative), fallback, sanitized }));
}
