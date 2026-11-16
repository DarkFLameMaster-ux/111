import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(await readFile(resolve(root, '..', '..', 'package.json'), 'utf8'));
const { name, version } = packageInfo;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  throw new Error('Root package.json must contain a semantic version.');
}
const src = resolve(root, 'src');
const publicDir = resolve(root, 'public');
const dist = resolve(root, 'dist');
// Keep the display frontend same-origin by default.  A localhost API base
// works on the host machine but points at the phone itself when the page is
// opened remotely, leaving the library empty.  Set RESLIB_API_BASE only when
// the frontend is intentionally deployed separately from the API service.
const apiBase = (process.env.RESLIB_API_BASE || '').replace(/\/+$/, '');

await mkdir(dist, { recursive: true });
await cp(publicDir, dist, { recursive: true });
await writeFile(resolve(dist, 'config.js'), `window.RESLIB_API_BASE = ${JSON.stringify(apiBase)};\n`, 'utf8');
const html = await readFile(resolve(src, 'index.html'), 'utf8');
await writeFile(resolve(dist, 'index.html'), html
  .replaceAll('__RESLIB_VERSION__', version)
  .replace(/<!-- RESLIB_BUILD -->/g, `<!-- RESLIB_BUILD api=${apiBase} -->`), 'utf8');
await writeFile(resolve(dist, 'version.json'), `${JSON.stringify({ name, version, frontend: 'display' }, null, 2)}\n`, 'utf8');
console.log(`display frontend v${version} built: ${dist}`);
console.log(`API base: ${apiBase}`);
