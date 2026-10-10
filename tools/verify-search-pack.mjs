#!/usr/bin/env node
// Verify an extracted release ZIP without installing it into the user's library.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { detectSearchPack, setSearchEnabled } from '../dist/search/pack.js';
import { SearchEmbedder } from '../dist/search/embedder.js';

if (!process.argv[2]) throw new Error('Usage: node tools/verify-search-pack.mjs <extracted-pack-folder>');
const folder = path.resolve(process.argv[2]);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scribe-pack-verify-'));
const embedder = new SearchEmbedder({ root });
try {
  await fsp.mkdir(path.join(root, 'packs'));
  await fsp.symlink(folder, path.join(root, 'packs/search'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = detectSearchPack(root);
  assert.equal(status.status, 'ready', status.message);
  for (const [name, expected] of Object.entries(status.pack.files)) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(folder, name))) hash.update(chunk);
    assert.equal(hash.digest('hex'), expected, `Hash mismatch: ${name}`);
  }
  console.log(`Verified ${Object.keys(status.pack.files).length} file hashes and pack detection`);
  setSearchEnabled(true, root);
  function check(vector) {
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 768);
    assert.ok(vector.every(Number.isFinite));
    assert.ok(vector.some(value => value !== 0));
  }
  const query = await embedder.embedQuery('a pet feline');
  const documents = await embedder.embedDocuments([
    { title: 'Cats', text: 'Domestic cats are popular household pets.' },
    { title: 'Roads', text: 'Asphalt road maintenance and traffic lights.' },
  ]);
  [query, ...documents].forEach(check);
  const dot = vector => vector.reduce((sum, value, i) => sum + value * query[i], 0);
  assert.ok(dot(documents[0]) > dot(documents[1]), 'Related document should rank higher');
  const sharp = createRequire(path.join(folder, 'package.json'))('sharp');
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#808080' } }).png().toBuffer();
  check(await embedder.embedImage(png));
  console.log('Offline query, documents, semantic ranking and image IPC checks passed');
} finally {
  embedder.dispose();
  // Remove the link explicitly before cleaning the temporary data folder.
  await fsp.unlink(path.join(root, 'packs/search')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('scribe-pack-verify-'));
  await fsp.rm(root, { recursive: true, force: true });
}
