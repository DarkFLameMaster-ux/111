import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(await readFile(resolve(root, '..', '..', 'package.json'), 'utf8'));
const { name, version } = packageInfo;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
  throw new Error('Root package.json must contain a semantic version.');
}
const dist = resolve(root, 'dist');
const apiBase = (process.env.RESLIB_SUB_API_BASE || 'http://127.0.0.1:8781').replace(/\/+$/, '');
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'public'), dist, { recursive: true });
await writeFile(resolve(dist, 'config.js'), `window.RESLIB_SUB_API_BASE = ${JSON.stringify(apiBase)};\n`, 'utf8');
const html = await readFile(resolve(root, 'src', 'index.html'), 'utf8');
await writeFile(resolve(dist, 'index.html'), html
  .replaceAll('__RESLIB_VERSION__', version)
  .replace('<!-- RESLIB_BUILD -->', `<!-- RESLIB_BUILD api=${apiBase} -->`), 'utf8');
await writeFile(resolve(dist, 'version.json'), `${JSON.stringify({ name, version, frontend: 'subscription' }, null, 2)}\n`, 'utf8');
console.log(`subscription frontend v${version} built: ${dist}`);
console.log(`API base: ${apiBase}`);
