import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
async function checkDirectory(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Syntax check failed: ${file}`);
    }
  }
}
for (const directory of ['desktop', 'scripts', 'frontend/display/scripts', 'frontend/subscription/scripts', 'frontend/display/dist', 'frontend/subscription/dist']) {
  await checkDirectory(directory);
}
for (const frontend of ['display', 'subscription']) {
  for (const directory of ['src', 'dist']) {
    const file = `frontend/${frontend}/${directory}/index.html`;
    const html = await readFile(resolve(root, file), 'utf8');
    for (const [index, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
      new vm.Script(match[1], { filename: `${file}:script-${index + 1}` });
    }
  }
}
console.log('JavaScript and frontend inline scripts: OK');
