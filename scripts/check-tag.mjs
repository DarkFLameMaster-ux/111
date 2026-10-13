import { checkVersion } from './version.mjs';

if (!process.env.RELEASE_TAG) throw new Error('RELEASE_TAG is required.');
await checkVersion(undefined, process.env.RELEASE_TAG);
console.log(`Release tag verified: ${process.env.RELEASE_TAG}`);
