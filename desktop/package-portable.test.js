const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function packageFixture(t, version = '8.4.2') {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'reslib-portable-test-'));
  const root = path.join(sandbox, 'project');
  const backupRoot = path.join(sandbox, 'backups');
  t.after(() => {
    assert.ok(path.resolve(sandbox).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(sandbox).startsWith('reslib-portable-test-'));
    fs.rmSync(sandbox, { recursive: true, force: true });
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
    'backend/runtime.py', 'backend/display/server.py', 'backend/display/compat.py', 'backend/subscription/server.py',
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
  const output = path.join(root, 'dist/current/display');
  function run(extraArgs = []) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'desktop/package-portable.ps1'), '-BackupRoot', backupRoot, ...extraArgs], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  }
  function backups() {
    if (!fs.existsSync(backupRoot)) return [];
    return fs.readdirSync(backupRoot, { recursive: true })
      .filter(file => path.basename(file) === 'build-info.json')
      .map(file => path.dirname(path.join(backupRoot, file)));
  }
  return { root, write, output, run, backupRoot, backups };
}

test('portable build uses fixed paths, whitelists runtime inputs and reuses Electron on updates', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  const first = fixture.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const packagedApp = path.join(fixture.output, 'resources/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(packagedApp, 'package.json')));
  const buildInfo = JSON.parse(fs.readFileSync(path.join(fixture.output, 'build-info.json')));
  assert.equal(manifest.version, '8.4.2');
  assert.equal(manifest.reslibRole, 'display');
  assert.equal(fs.existsSync(path.join(packagedApp, 'backend/subscription/server.py')), false);
  assert.equal(fs.existsSync(path.join(packagedApp, 'frontend/subscription')), false);
  const manager = path.join(fixture.root, 'dist/current/management');
  assert.ok(fs.existsSync(path.join(manager, 'Moonshadow-management.exe')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(manager, 'resources/app/package.json'))).reslibRole, 'management');
  assert.equal(fs.existsSync(path.join(manager, 'resources/app/frontend/display')), false);
  assert.ok(fs.existsSync(path.join(manager, 'resources/app/backend/subscription/server.py')));
  assert.equal(manifest.description, '资源库打包测试');
  assert.equal(buildInfo.version, manifest.version);
  assert.equal(buildInfo.architecture, 'x64');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'locales/zh-CN.pak'), 'utf8'), 'runtime locale');
  assert.ok(fs.existsSync(path.join(fixture.output, 'Moonshadow-display.exe')));
  assert.ok(fs.existsSync(path.join(packagedApp, 'backend/display/compat.py')));
  const outputFiles = fs.readdirSync(packagedApp, { recursive: true });
  assert.equal(outputFiles.some(file => /private|node_modules|cache|logs|\.env|package-portable|test\.js/.test(file)), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'dist/old-release/keep.txt'), 'utf8'), 'previous release');
  const runtimeExe = path.join(fixture.output, 'Moonshadow-display.exe');
  const runtimeModified = fs.statSync(runtimeExe).mtimeMs;
  fixture.write(path.relative(fixture.root, path.join(fixture.output, 'keep.txt')), 'existing runtime');
  fixture.write('desktop/main.js', 'updated app code');
  const repeated = fixture.run();
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.equal(fs.readFileSync(path.join(fixture.output, 'keep.txt'), 'utf8'), 'existing runtime');
  assert.equal(fs.statSync(runtimeExe).mtimeMs, runtimeModified);
  assert.equal(fs.readFileSync(path.join(packagedApp, 'desktop/main.js'), 'utf8'), 'updated app code');
  assert.equal(fixture.backups().length, 2);
  for (const backup of fixture.backups()) {
    const oldInfo = JSON.parse(fs.readFileSync(path.join(backup, 'build-info.json')));
    assert.equal(oldInfo.version, '8.4.2');
    assert.equal(fs.existsSync(path.join(backup, `Moonshadow-${oldInfo.role}.exe`)), false);
    assert.equal(fs.existsSync(path.join(backup, 'locales')), false);
    assert.equal(fs.readFileSync(path.join(backup, 'resources/app/desktop/main.js'), 'utf8'), 'fixture: desktop/main.js');
  }
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).some(name => name.startsWith('.packaging-')), false);
});

test('a new software version updates the same current paths', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  assert.equal(fixture.run().status, 0);
  for (const file of ['package.json', 'package-lock.json', 'CHANGELOG.md',
    'frontend/display/dist/index.html', 'frontend/display/dist/version.json',
    'frontend/subscription/dist/index.html', 'frontend/subscription/dist/version.json']) {
    fixture.write(file, fs.readFileSync(path.join(fixture.root, file), 'utf8').replaceAll('8.4.2', '8.4.3'));
  }
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.output, 'build-info.json'))).version, '8.4.3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.output, 'resources/app/package.json'))).version, '8.4.3');
  assert.equal(fs.readdirSync(path.join(fixture.root, 'dist')).some(name => name.startsWith('v8.')), false);
  assert.ok(fixture.backups().every(backup => JSON.parse(fs.readFileSync(path.join(backup, 'build-info.json'))).version === '8.4.2'));
});

test('an Electron upgrade preserves the previous complete runtime outside the project', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  assert.equal(fixture.run().status, 0);
  fixture.write('node_modules/electron/dist/version', '40.10.3');
  fixture.write('node_modules/electron/dist/locales/zh-CN.pak', 'new runtime locale');
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.output, 'build-info.json'))).electronVersion, '40.10.3');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'locales/zh-CN.pak'), 'utf8'), 'new runtime locale');
  assert.equal(fixture.backups().length, 2);
  for (const backup of fixture.backups()) {
    const oldInfo = JSON.parse(fs.readFileSync(path.join(backup, 'build-info.json')));
    assert.equal(oldInfo.electronVersion, '40.10.2');
    assert.ok(fs.existsSync(path.join(backup, `Moonshadow-${oldInfo.role}.exe`)));
    assert.equal(fs.readFileSync(path.join(backup, 'locales/zh-CN.pak'), 'utf8'), 'runtime locale');
  }
});

test('all role inputs are checked before either current program changes', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  fs.unlinkSync(path.join(fixture.root, 'backend/subscription/server.py'));
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required input is missing/);
  assert.equal(fs.existsSync(fixture.output), false);
  assert.equal(fixture.backups().length, 0);
});

test('a running current program blocks both updates', { skip: process.platform !== 'win32' }, async t => {
  const fixture = packageFixture(t);
  assert.equal(fixture.run().status, 0);
  const exe = path.join(fixture.output, 'Moonshadow-display.exe');
  fs.copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    assert.equal(child.exitCode, null);
    fixture.write('desktop/main.js', 'must not replace a running app');
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Close the running display program/);
    assert.equal(fs.readFileSync(path.join(fixture.output, 'resources/app/desktop/main.js'), 'utf8'), 'fixture: desktop/main.js');
    assert.equal(fixture.backups().length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

test('failed app replacement restores the previous app', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  assert.equal(fixture.run().status, 0);
  fixture.write('desktop/main.js', 'replacement code');
  fs.chmodSync(path.join(fixture.output, 'build-info.json'), 0o444);
  const result = fixture.run(['-Role', 'display']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(fixture.output, 'resources/app/desktop/main.js'), 'utf8'), 'fixture: desktop/main.js');
  assert.ok(fs.existsSync(path.join(fixture.output, 'Moonshadow-display.exe')));
  assert.match(result.stdout + result.stderr, /Packaging failed/);
});

test('junctions in a current runtime cannot redirect an update', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  assert.equal(fixture.run().status, 0);
  fixture.write('outside/keep.txt', 'unrelated');
  fs.symlinkSync(path.join(fixture.root, 'outside'), path.join(fixture.output, 'linked'), 'junction');
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link or junction/);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'outside/keep.txt'), 'utf8'), 'unrelated');
  assert.equal(fixture.backups().length, 0);
});

test('backup directories inside the project are refused', { skip: process.platform !== 'win32' }, t => {
  const fixture = packageFixture(t);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(fixture.root, 'desktop/package-portable.ps1'), '-BackupRoot', path.join(fixture.root, 'backups')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backups must be outside/);
  assert.equal(fs.existsSync(fixture.output), false);
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
