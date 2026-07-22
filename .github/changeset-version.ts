import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { updateSdkVersionSource } from './version-prep.ts';

// Prepares ONLY internal package release state for a Version Packages PR:
// package.json versions (changesets), the lockfile, and the SDK_VERSION
// constant. It deliberately does NOT advance consumer-facing references
// (example Dockerfiles, docs); those are advanced by promote-references.ts
// only after the release is fully published and verified.

// `changeset version` does not update package-lock.json, so refresh the
// lockfile without touching node_modules.
// See https://github.com/changesets/changesets/issues/421.
execSync('npx changeset version', { stdio: 'inherit' });
execSync('npm install --package-lock-only', { stdio: 'inherit' });

const versionFilePath = './packages/sandbox/src/version.ts';
const packageJson = JSON.parse(
  readFileSync('./packages/sandbox/package.json', 'utf-8')
) as { version: string };
const newVersion = packageJson.version;

const updatedVersionFile = updateSdkVersionSource(
  readFileSync(versionFilePath, 'utf-8'),
  newVersion
);
writeFileSync(versionFilePath, updatedVersionFile);

console.log(`Prepared internal release state for version ${newVersion}`);
