import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextVersion, bumpVersion, checkVersion } from './version.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reslib-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = { name: 'test-reslib', version: '0.2.0' };
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: pkg.version, packages: { '': pkg } }));
  await writeFile(join(root, 'CHANGELOG.md'), '# Changes\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed playback.\n\n## [0.2.0] - 2026-10-12\n\n- Baseline.\n');
  await buildFixture(root, pkg.version);
  return root;
}

async function buildFixture(root, version) {
  for (const frontend of ['display', 'subscription']) {
    const dist = join(root, 'frontend', frontend, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'version.json'), JSON.stringify({ name: 'test-reslib', version, frontend }));
    await writeFile(join(dist, 'index.html'), `<span>软件 v${version}</span>`);
  }
}

test('version increments reset lower components and reject invalid or older versions', () => {
  assert.equal(nextVersion('0.2.9', 'patch'), '0.2.10');
  assert.equal(nextVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.9', 'major'), '1.0.0');
  assert.equal(nextVersion('0.9.0', '0.10.0'), '0.10.0');
  for (const value of ['0.2.8', '0.2.9', '01.3.0', '0.3', '0.3.0-beta', 'v0.3.0', undefined]) {
    assert.throws(() => nextVersion('0.2.9', value));
  }
});

test('bump moves unreleased notes, syncs lockfile, and detects stale frontend outputs', async t => {
  const root = await fixture(t);
  assert.equal(await checkVersion(root, 'v0.2.0'), '0.2.0');
  assert.equal(await bumpVersion(root, 'minor', '2026-10-12'), '0.3.0');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, '0.3.0');
  assert.equal(lock.packages[''].version, '0.3.0');
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[Unreleased\]\n\n## \[0.3.0\] - 2026-10-12\n\n### Fixed/);
  assert.equal(changelog.match(/Fixed playback/g).length, 1);
  await assert.rejects(checkVersion(root), /stale/);
  await buildFixture(root, '0.3.0');
  assert.equal(await checkVersion(root, 'v0.3.0'), '0.3.0');
  await assert.rejects(checkVersion(root, 'v0.2.0'), /Expected tag/);
  await assert.rejects(bumpVersion(root, 'patch'), /real change notes/);
});

test('invalid dates and missing notes fail without changing version files', async t => {
  const root = await fixture(t);
  const original = await readFile(join(root, 'package.json'), 'utf8');
  await assert.rejects(bumpVersion(root, 'patch', '2026-02-30'), /real YYYY-MM-DD/);
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original);
  await writeFile(join(root, 'CHANGELOG.md'), '## [Unreleased]\n\n### Fixed\n\n## [0.2.0] - 2026-10-12\n');
  await assert.rejects(bumpVersion(root, 'patch'), /real change notes/);
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original);
});

test('release check rejects malformed latest release, invalid dates and unsynced lockfiles', async t => {
  const root = await fixture(t);
  const log = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  await writeFile(join(root, 'CHANGELOG.md'), log.replace('## [0.2.0]', '## [0.3.0] - TBD\n\n## [0.2.0]'));
  await assert.rejects(checkVersion(root), /latest CHANGELOG/);
  await writeFile(join(root, 'CHANGELOG.md'), log.replace('2026-10-12', '2026-02-30'));
  await assert.rejects(checkVersion(root), /real YYYY-MM-DD/);
  await writeFile(join(root, 'CHANGELOG.md'), log);
  await writeFile(join(root, 'package-lock.json'), '{"version":"0.1.0"}');
  await assert.rejects(checkVersion(root), /differs/);
});
