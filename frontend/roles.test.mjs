import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('display keeps the full document, browsing and reader structure without management calls', async () => {
  const html = await readFile(new URL('./display/src/index.html', import.meta.url), 'utf8');
  for (const marker of ['<body>', '</style>', '<main>', 'id="pageTitle"', 'id="q"', 'id="view"', 'id="reader"', 'id="vp"', 'id="musicAudio"', 'function render()', 'function load(', 'function saveProgressEntry(']) {
    assert.ok(html.includes(marker), marker);
  }
  for (const route of ['/api/settings', '/api/archive', '/api/reindex', '/api/scrape', '/api/subs', '/api/health', '/api/cache', '/api/comic/cache']) {
    assert.equal(html.includes(route), false, route);
  }
  assert.equal(html.includes('id="opdsBtn"'), false);
  assert.equal(html.includes('id="archiveOverlay"'), false);
  assert.ok(html.includes('/api/preferences'));
});
