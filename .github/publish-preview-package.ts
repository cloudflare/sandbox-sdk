import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  prepareNpmPackage,
  type NpmPrepInput,
  type PreparedNpmPackage
} from './npm-package-prep.ts';

export interface PreviewPackageInput {
  releaseRoot: string;
  versionOverride: string;
}

export interface PreviewPackageDeps {
  readFile(path: string): string;
  prepareNpmPackage(input: NpmPrepInput): Promise<PreparedNpmPackage>;
  publish(packageDir: string): Promise<void>;
}

const nodePreviewPackageDeps: PreviewPackageDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  prepareNpmPackage,
  publish: async (packageDir) => {
    execFileSync('npx', ['pkg-pr-new', 'publish', packageDir], {
      stdio: 'inherit'
    });
  }
};

export async function publishPreviewPackage(
  input: PreviewPackageInput,
  deps: PreviewPackageDeps = nodePreviewPackageDeps
): Promise<void> {
  const manifest = parsePackageManifest(
    deps.readFile(join(input.releaseRoot, 'packages/sandbox/package.json'))
  );
  const prepared = await deps.prepareNpmPackage({
    releaseRoot: input.releaseRoot,
    packageName: '@cloudflare/sandbox',
    version: manifest.version,
    versionOverride: input.versionOverride
  });

  try {
    await deps.publish(prepared.packageDir);
  } finally {
    await prepared.cleanup();
  }
}

function parsePackageManifest(content: string): { version: string } {
  const manifest: unknown = JSON.parse(content);
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0
  ) {
    throw new Error('Sandbox package manifest has no version');
  }
  return { version: manifest.version };
}

function requireArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument: ${name ?? ''}`);
    }
    args.set(name, value);
  }

  await publishPreviewPackage({
    releaseRoot: requireArg(args, '--release-root'),
    versionOverride: requireArg(args, '--version')
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
