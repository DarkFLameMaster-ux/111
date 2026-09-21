import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const apiBase = (process.env.RESLIB_SUB_API_BASE || 'http://127.0.0.1:8781').replace(/\/+$/, '');
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'src', 'index.html'), resolve(dist, 'index.html'));
await cp(resolve(root, 'public'), dist, { recursive: true });
await writeFile(resolve(dist, 'config.js'), `window.RESLIB_SUB_API_BASE = ${JSON.stringify(apiBase)};\n`, 'utf8');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
await writeFile(resolve(dist, 'index.html'), html.replace('<!-- RESLIB_BUILD -->', `<!-- RESLIB_BUILD api=${apiBase} -->`), 'utf8');
console.log(`subscription frontend built: ${dist}`);
console.log(`API base: ${apiBase}`);
