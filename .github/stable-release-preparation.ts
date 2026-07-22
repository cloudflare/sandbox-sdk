import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareNpmPackage,
  type PreparedNpmPackage
} from './npm-package-prep.ts';
import type { StableReleaseContext } from './stable-release-context.ts';

export const SANDBOX_BINARY_IN_IMAGE = '/container-server/sandbox';

export interface PreparedAsset {
  name: string;
  path: string;
}

export interface PreparedRelease {
  npm: PreparedNpmPackage;
  assets: readonly PreparedAsset[];
  requiredAssets: readonly string[];
  cleanup(): Promise<void>;
}

export interface StablePrepareDeps {
  makeTempDir(prefix: string): string;
  remove(path: string): void;
  exists(path: string): boolean;
  extractBinary(sourceRef: string, outputPath: string): Promise<void>;
  writeSHA256(inputPath: string, checksumPath: string): Promise<void>;
  prepareNpmPackage(input: {
    releaseRoot: string;
    packageName: '@cloudflare/sandbox';
    version: string;
  }): Promise<PreparedNpmPackage>;
}

export const nodeStablePrepareDeps: StablePrepareDeps = {
  makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  exists: existsSync,
  extractBinary: async (sourceRef, outputPath) =>
    extractBinaryWithDocker(sourceRef, outputPath),
  writeSHA256: async (inputPath, checksumPath) =>
    writeSHA256WithNode(inputPath, checksumPath),
  prepareNpmPackage
};

export async function prepareStableRelease(
  context: StableReleaseContext,
  deps: StablePrepareDeps = nodeStablePrepareDeps
): Promise<PreparedRelease> {
  const assetRoot = deps.makeTempDir('sandbox-assets-');
  let npm: PreparedNpmPackage | undefined;
  let npmCleaned = false;
  let assetsCleaned = false;
  const cleanup = async () => {
    if (npmCleaned && assetsCleaned) {
      return;
    }

    const failures: unknown[] = [];
    if (npm !== undefined && !npmCleaned) {
      try {
        await npm.cleanup();
        npmCleaned = true;
      } catch (error) {
        failures.push(error);
      }
    } else if (npm === undefined) {
      npmCleaned = true;
    }
    if (!assetsCleaned) {
      try {
        deps.remove(assetRoot);
        assetsCleaned = true;
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to clean prepared release');
    }
  };

  try {
    npm = await deps.prepareNpmPackage({
      releaseRoot: context.releaseRoot,
      packageName: '@cloudflare/sandbox',
      version: context.version
    });
    const binarySources = requiredBinarySources(context);
    const assets: PreparedAsset[] = [];
    for (const binary of binarySources) {
      const binaryPath = join(assetRoot, binary.assetName);
      const checksumPath = `${binaryPath}.sha256`;
      await deps.extractBinary(binary.sourceRef, binaryPath);
      await deps.writeSHA256(binaryPath, checksumPath);
      assets.push(
        { name: binary.assetName, path: binaryPath },
        { name: `${binary.assetName}.sha256`, path: checksumPath }
      );
    }
    const requiredAssets = [
      'sandbox-linux-x64',
      'sandbox-linux-x64.sha256',
      'sandbox-linux-x64-musl',
      'sandbox-linux-x64-musl.sha256'
    ];
    for (const asset of assets) {
      if (!deps.exists(asset.path)) {
        throw new Error(`Prepared release asset is missing: ${asset.path}`);
      }
    }
    return { npm, assets, requiredAssets, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        error instanceof Error
          ? error.message
          : 'Stable release preparation failed and cleanup also failed'
      );
    }
    throw error;
  }
}

function requiredBinarySources(context: StableReleaseContext): {
  image: string;
  sourceRef: string;
  assetName: string;
}[] {
  const sandbox = context.dockerImages.find(
    (mapping) => mapping.image === 'sandbox'
  );
  const musl = context.dockerImages.find(
    (mapping) => mapping.image === 'sandbox-musl'
  );
  if (sandbox === undefined) {
    throw new Error(
      'docker-images.txt must include sandbox for sandbox-linux-x64 extraction'
    );
  }
  if (musl === undefined) {
    throw new Error(
      'docker-images.txt must include sandbox-musl for sandbox-linux-x64-musl extraction'
    );
  }
  return [
    {
      image: 'sandbox',
      sourceRef: sandbox.sourceRef,
      assetName: 'sandbox-linux-x64'
    },
    {
      image: 'sandbox-musl',
      sourceRef: musl.sourceRef,
      assetName: 'sandbox-linux-x64-musl'
    }
  ];
}

function extractBinaryWithDocker(sourceRef: string, outputPath: string): void {
  execFileSync('docker', ['pull', sourceRef], { stdio: 'inherit' });
  const containerId = execFileSync('docker', ['create', sourceRef], {
    encoding: 'utf8'
  }).trim();
  try {
    execFileSync(
      'docker',
      ['cp', `${containerId}:${SANDBOX_BINARY_IN_IMAGE}`, outputPath],
      { stdio: 'inherit' }
    );
  } finally {
    execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
  }
}

function writeSHA256WithNode(inputPath: string, checksumPath: string): void {
  const digest = createHash('sha256')
    .update(readFileSync(inputPath))
    .digest('hex');
  writeFileSync(
    checksumPath,
    `${digest}  ${inputPath.split('/').pop() ?? inputPath}\n`
  );
}
