const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function packageFixture(t, version = '8.4.2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reslib-portable-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('reslib-portable-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  write('package.json', JSON.stringify({ name: 'fixture-app', version, description: '资源库打包测试' }));
  write('package-lock.json', JSON.stringify({ version, packages: { '': { version } } }));
  write('CHANGELOG.md', `## [Unreleased]\n\n## [${version}] - 2026-10-12\n\n- Fixture release.\n`);
  write('scripts/version.mjs', fs.readFileSync(path.join(__dirname, '../scripts/version.mjs')));
  write('desktop/package-portable.ps1', fs.readFileSync(path.join(__dirname, 'package-portable.ps1')));
  const executable = Buffer.alloc(256);
  executable.writeUInt16LE(0x5a4d, 0);
  executable.writeInt32LE(128, 0x3c);
  executable.writeUInt32LE(0x4550, 128);
  executable.writeUInt16LE(0x8664, 132);
  write('node_modules/electron/dist/electron.exe', executable);
  write('node_modules/electron/dist/version', '40.10.2');
  write('node_modules/electron/dist/locales/zh-CN.pak', 'runtime locale');
  for (const file of [
    'desktop/main.js', 'desktop/preload.js', 'desktop/reader-shortcuts.js',
    'backend/display/server.py', 'backend/display/compat.py', 'backend/subscription/server.py',
    'frontend/display/dist/index.html', 'frontend/display/dist/config.js',
    'frontend/subscription/dist/index.html', 'frontend/subscription/dist/config.js',
  ]) write(file, `fixture: ${file}`);
  for (const frontend of ['display', 'subscription']) {
    write(`frontend/${frontend}/dist/index.html`, `<title>Fixture v${version}</title>`);
    write(`frontend/${frontend}/dist/version.json`, JSON.stringify({ name: 'fixture-app', version, frontend }));
  }
  for (const file of [
    'frontend/display/node_modules/private.txt', 'frontend/display/src/private.txt',
    'frontend/display/dist/node_modules/private.txt', 'frontend/display/dist/logs/private.txt',
    'frontend/display/dist/cache/private.txt', 'frontend/display/dist/.env',
    'backend/display/__pycache__/server.pyc', 'backend/private.json', 'desktop/private.json',
  ]) write(file, 'must never be packaged');
  write('dist/old-release/keep.txt', 'previous release');
  const output = path.join(root, 'dist', `v${version}`, `Moonshadow-Reslib-${version}-win32-x64`);
  function run() {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'desktop/package-portable.ps1')], { encoding: 'utf8', timeout: 30000 });
  }
  return { root, write, output, run };
}

test('portable build derives version, copies only runtime inputs and preserves prior builds', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  const first = fixture.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const packagedApp = path.join(fixture.output, 'resources/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(packagedApp, 'package.json')));
  const buildInfo = JSON.parse(fs.readFileSync(path.join(fixture.output, 'build-info.json')));
  assert.equal(manifest.version, '8.4.2');
  assert.equal(manifest.description, '资源库打包测试');
  assert.equal(buildInfo.version, manifest.version);
  assert.equal(buildInfo.architecture, 'x64');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'locales/zh-CN.pak'), 'utf8'), 'runtime locale');
  assert.ok(fs.existsSync(path.join(fixture.output, 'Moonshadow-Reslib.exe')));
  assert.ok(fs.existsSync(path.join(packagedApp, 'backend/display/compat.py')));
  const outputFiles = fs.readdirSync(packagedApp, { recursive: true });
  assert.equal(outputFiles.some(file => /private|node_modules|cache|logs|\.env|package-portable|test\.js/.test(file)), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'dist/old-release/keep.txt'), 'utf8'), 'previous release');
  fixture.write(path.relative(fixture.root, path.join(fixture.output, 'keep.txt')), 'do not replace');
  const repeated = fixture.run();
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /already exists/);
  assert.equal(fs.readFileSync(path.join(fixture.output, 'keep.txt'), 'utf8'), 'do not replace');
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).some(name => name.startsWith('.packaging-')), false);
});

test('missing frontend build stops before creating a partial release', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  fs.unlinkSync(path.join(fixture.root, 'frontend/display/dist/index.html'));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Version check failed/);
  assert.equal(fs.existsSync(fixture.output), false);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).length, 1);
});

test('invalid versions cannot become output paths', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t, '../escape');
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid semantic version/);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).length, 1);
});

test('frontend extras and junctions are absent from the explicit artifact whitelist', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  fixture.write('outside/secret.txt', 'must remain outside');
  fs.symlinkSync(path.join(fixture.root, 'outside'), path.join(fixture.root, 'frontend/display/dist/linked'), 'junction');
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(fixture.output, 'resources/app/frontend/display/dist/linked')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'dist/old-release/keep.txt'), 'utf8'), 'previous release');
});

test('stale frontend metadata prevents direct packaging', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  fixture.write('frontend/display/dist/version.json', JSON.stringify({ name: 'fixture-app', version: '8.4.1', frontend: 'display' }));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version.json is stale/);
  assert.equal(fs.existsSync(fixture.output), false);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).length, 1);
});
