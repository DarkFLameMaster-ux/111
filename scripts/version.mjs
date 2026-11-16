import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Release date must be a real YYYY-MM-DD date.');
  }
}

export function nextVersion(current, requested) {
  if (!stableVersion.test(current)) throw new Error(`Invalid current version: ${current}`);
  const parts = current.split('.').map(BigInt);
  const index = ['major', 'minor', 'patch'].indexOf(requested);
  let next = requested;
  if (index >= 0) {
    parts[index] += 1n;
    for (let i = index + 1; i < 3; i++) parts[i] = 0n;
    next = parts.join('.');
  }
  if (!stableVersion.test(next || '')) throw new Error('Use major, minor, patch, or a stable X.Y.Z version.');
  const before = current.split('.').map(BigInt);
  const after = next.split('.').map(BigInt);
  const changed = after.findIndex((part, i) => part !== before[i]);
  if (changed < 0 || after[changed] < before[changed]) throw new Error('The new version must be greater than the current version.');
  return next;
}

async function readProject(root) {
  const pkg = await readJson(resolve(root, 'package.json'));
  const lock = await readJson(resolve(root, 'package-lock.json'));
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  if (!stableVersion.test(pkg.version)) throw new Error('package.json must contain a stable X.Y.Z version.');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package-lock.json version differs from package.json.');
  }
  return { pkg, lock, changelog };
}

export async function checkVersion(root = projectRoot, tag) {
  const { pkg, changelog } = await readProject(root);
  const firstRelease = changelog.split(/\r?\n/).find(line => line.startsWith('## [') && line !== '## [Unreleased]');
  const latest = firstRelease?.match(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/);
  if (!latest || latest[1] !== pkg.version) throw new Error('The latest CHANGELOG.md release must match package.json.');
  validateDate(latest[2]);
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Expected tag v${pkg.version}, received ${tag}.`);
  for (const frontend of ['display', 'subscription']) {
    const base = resolve(root, 'frontend', frontend, 'dist');
    const metadata = await readJson(resolve(base, 'version.json'));
    const html = await readFile(resolve(base, 'index.html'), 'utf8');
    if (metadata.version !== pkg.version || metadata.name !== pkg.name || metadata.frontend !== frontend) {
      throw new Error(`${frontend} version.json is stale; run npm run build.`);
    }
    if (html.includes('__RESLIB_VERSION__') || !html.includes(`v${pkg.version}`)) {
      throw new Error(`${frontend} HTML version is stale; run npm run build.`);
    }
  }
  return pkg.version;
}

export async function bumpVersion(root, requested, date = new Date().toISOString().slice(0, 10)) {
  const { pkg, lock, changelog } = await readProject(root);
  const next = nextVersion(pkg.version, requested);
  validateDate(date);
  const unreleased = /^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[|$(?![\s\S]))/m;
  const match = changelog.match(unreleased);
  if (!match || !/^[-*] \S/m.test(match[1])) throw new Error('Add real change notes under ## [Unreleased] before bumping.');
  if (changelog.includes(`## [${next}]`)) throw new Error(`CHANGELOG.md already contains ${next}.`);
  const updatedLog = changelog.replace(unreleased, `## [Unreleased]\n\n## [${next}] - ${date}\n\n${match[1].trim()}\n\n`);
  pkg.version = next;
  lock.version = next;
  lock.packages[''].version = next;
  // Validate all inputs before changing any file. No Git operations happen here.
  await writeFile(resolve(root, 'package.json'), json(pkg));
  await writeFile(resolve(root, 'package-lock.json'), json(lock));
  await writeFile(resolve(root, 'CHANGELOG.md'), updatedLog);
  return next;
}

async function main(args) {
  const [command, value, flag, date] = args;
  if (command === 'show' && args.length === 1) {
    console.log((await readJson(resolve(projectRoot, 'package.json'))).version);
  } else if (command === 'check' && (args.length === 1 || (value === '--tag' && args.length === 3))) {
    console.log(`Version check passed: v${await checkVersion(projectRoot, value === '--tag' ? flag : undefined)}`);
  } else if (command === 'bump' && (args.length === 2 || (flag === '--date' && args.length === 4))) {
    const next = await bumpVersion(projectRoot, value, date);
    console.log(`Prepared v${next}. Run npm run release:check, then review and commit the changes.`);
  } else {
    throw new Error('Usage: version.mjs show | check [--tag vX.Y.Z] | bump <patch|minor|major|X.Y.Z> [--date YYYY-MM-DD]');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
