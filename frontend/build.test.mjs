import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = fileURLToPath(new URL('./', import.meta.url));

for (const frontend of ['display', 'subscription']) {
  test(`${frontend} build follows the root version from any working directory`, async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'reslib-frontend-test-'));
    t.after(async () => {
      assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
      assert.ok(basename(fixture).startsWith('reslib-frontend-test-'));
      await rm(fixture, { recursive: true, force: true });
    });
    const app = join(fixture, 'frontend', frontend);
    await mkdir(app, { recursive: true });
    for (const directory of ['scripts', 'src', 'public']) {
      await cp(join(source, frontend, directory), join(app, directory), { recursive: true });
    }
    const env = { ...process.env };
    delete env.RESLIB_API_BASE;
    delete env.RESLIB_SUB_API_BASE;
    const apiKey = frontend === 'display' ? 'RESLIB_API_BASE' : 'RESLIB_SUB_API_BASE';
    for (const version of ['1.2.3-preview.1+fixture', '1.3.0']) {
      const manifest = { name: 'reslib-build-fixture', version };
      await writeFile(join(fixture, 'package.json'), JSON.stringify(manifest));
      const expectedApi = version === '1.3.0' ? 'https://example.invalid/api' : frontend === 'display' ? '' : 'http://127.0.0.1:8781';
      if (version === '1.3.0') env[apiKey] = `${expectedApi}/`;
      const result = spawnSync(process.execPath, [join(app, 'scripts', 'build.mjs')], {
        cwd: tmpdir(), env, encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const dist = join(app, 'dist');
      assert.deepEqual(JSON.parse(await readFile(join(dist, 'version.json'), 'utf8')), { ...manifest, frontend });
      const html = await readFile(join(dist, 'index.html'), 'utf8');
      assert.ok(html.includes(`软件 v${version}`));
      assert.ok(html.includes(`name="application-version" content="${version}"`));
      assert.ok(!html.includes('__RESLIB_VERSION__'));
      assert.equal(await readFile(join(dist, 'config.js'), 'utf8'), `window.${apiKey} = ${JSON.stringify(expectedApi)};\n`);
      await assert.rejects(readFile(join(app, 'scripts', 'dist', 'version.json')), { code: 'ENOENT' });
    }
  });
}
