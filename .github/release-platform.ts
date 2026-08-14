import { spawnSync } from 'node:child_process';
import type { PreparedNpmPackage } from './npm-package-prep.ts';
import {
  commitSHA,
  imageDigest,
  stableVersion,
  versionTag,
  type CommitSHA,
  type ImageDigest,
  type NpmPackageName,
  type StableVersion,
  type VersionTag
} from './release-primitives.ts';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessExecutor {
  command(command: string, args: readonly string[]): Promise<ProcessResult>;
}

export interface NpmVersionInfo {
  version: StableVersion;
}

export interface GitHubReleaseInfo {
  tagName: VersionTag;
  assets: readonly string[];
}

export interface DockerRef {
  repository: string;
  tag: string;
}

type SandboxPackageName = NpmPackageName | '@cloudflare/sandbox';

export interface NpmReleaseClient {
  inspectVersion(
    name: SandboxPackageName,
    version: StableVersion
  ): Promise<NpmVersionInfo | undefined>;
  inspectDistTag(
    name: SandboxPackageName,
    tag: 'latest'
  ): Promise<StableVersion | undefined>;
  publishPreparedPackage(
    prepared: PreparedNpmPackage,
    tag: string
  ): Promise<void>;
}

export interface GitTagClient {
  resolveTag(tag: VersionTag): Promise<CommitSHA | undefined>;
  createTag(tag: VersionTag, sha: CommitSHA): Promise<void>;
}

export interface GitHubReleaseClient {
  inspectRelease(name: VersionTag): Promise<GitHubReleaseInfo | undefined>;
  createRelease(name: VersionTag, sha: CommitSHA, notes: string): Promise<void>;
  uploadAsset(name: VersionTag, path: string): Promise<void>;
}

export interface DockerRegistryClient {
  resolveDigest(ref: DockerRef): Promise<ImageDigest | undefined>;
  copyImage(source: DockerRef, target: DockerRef): Promise<void>;
}

export interface ReleasePlatform {
  npm: NpmReleaseClient;
  git: GitTagClient;
  github: GitHubReleaseClient;
  docker: DockerRegistryClient;
}

export class ExecReleasePlatform implements ReleasePlatform {
  readonly npm: NpmReleaseClient;
  readonly git: GitTagClient;
  readonly github: GitHubReleaseClient;
  readonly docker: DockerRegistryClient;

  constructor(executor: ProcessExecutor = nodeExecutor) {
    this.npm = createNpmClient(executor);
    this.git = createGitClient(executor);
    this.github = createGitHubClient(executor);
    this.docker = createDockerClient(executor);
  }
}

function isNpmMissing(result: ProcessResult): boolean {
  return (
    result.exitCode !== 0 &&
    /\bE404\b|is not in this registry/.test(result.stderr)
  );
}

function isGhMissing(result: ProcessResult): boolean {
  return result.exitCode !== 0 && /not found|HTTP 404/i.test(result.stderr);
}

function isCraneMissing(result: ProcessResult): boolean {
  return (
    result.exitCode !== 0 &&
    /MANIFEST_UNKNOWN|manifest unknown|not found/i.test(result.stderr)
  );
}

function requireSuccess(domain: string, result: ProcessResult): string {
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  throw new Error(`${domain} failed: ${result.stderr.trim()}`);
}

function createNpmClient(executor: ProcessExecutor): NpmReleaseClient {
  return {
    inspectVersion: async (name, version) => {
      const packageVersion = `${name}@${version}`;
      const result = await executor.command('npm', [
        'view',
        packageVersion,
        'version',
        '--json',
        '--prefer-online'
      ]);
      if (isNpmMissing(result)) {
        return undefined;
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `npm inspect failed for ${packageVersion}: ${result.stderr.trim()}`
        );
      }
      const output = result.stdout.trim();
      return { version: stableVersion(parseJSONString(output, 'npm version')) };
    },
    inspectDistTag: async (name, tag) => {
      const result = await executor.command('npm', [
        'view',
        name,
        `dist-tags.${tag}`,
        '--json',
        '--prefer-online'
      ]);
      if (isNpmMissing(result)) {
        return undefined;
      }
      const output = requireSuccess(`npm inspect for ${name}:${tag}`, result);
      if (output.length === 0 || output === 'null') {
        return undefined;
      }
      return stableVersion(parseJSONString(output, `npm dist-tag ${tag}`));
    },
    publishPreparedPackage: async (prepared, tag) => {
      requireSuccess(
        `npm publish for ${prepared.packageName}@${prepared.version}`,
        await executor.command('npm', [
          'publish',
          prepared.tarballPath,
          '--access',
          'public',
          '--tag',
          tag
        ])
      );
    }
  };
}

function createGitClient(executor: ProcessExecutor): GitTagClient {
  return {
    resolveTag: async (tag) => {
      const result = await executor.command('git', [
        'ls-remote',
        '--tags',
        'origin',
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`
      ]);
      if (result.exitCode !== 0) {
        throw new Error(
          `git resolve tag ${tag} failed: ${result.stderr.trim()}`
        );
      }
      const refs = result.stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => line.split(/\s+/, 2));
      const peeled = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0];
      const direct = refs.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
      const sha = peeled ?? direct;
      return sha === undefined ? undefined : commitSHA(sha);
    },
    createTag: async (tag, sha) => {
      requireSuccess(
        `git create tag ${tag}`,
        await executor.command('gh', [
          'api',
          '--method',
          'POST',
          'repos/{owner}/{repo}/git/refs',
          '-f',
          `ref=refs/tags/${tag}`,
          '-f',
          `sha=${sha}`
        ])
      );
    }
  };
}

function createGitHubClient(executor: ProcessExecutor): GitHubReleaseClient {
  return {
    inspectRelease: async (name) => {
      const result = await executor.command('gh', [
        'release',
        'view',
        name,
        '--json',
        'tagName,assets'
      ]);
      if (isGhMissing(result)) {
        return undefined;
      }
      const output = requireSuccess(`github inspect release ${name}`, result);
      return parseGitHubRelease(output);
    },
    createRelease: async (name, sha, notes) => {
      requireSuccess(
        `github create release ${name}`,
        await executor.command('gh', [
          'release',
          'create',
          name,
          '--target',
          sha,
          '--title',
          name,
          '--notes',
          notes
        ])
      );
    },
    uploadAsset: async (name, path) => {
      requireSuccess(
        `github upload asset ${name}`,
        await executor.command('gh', ['release', 'upload', name, path])
      );
    }
  };
}

function createDockerClient(executor: ProcessExecutor): DockerRegistryClient {
  return {
    resolveDigest: async (ref) => {
      const rendered = renderDockerRef(ref);
      const result = await executor.command('crane', ['digest', rendered]);
      if (isCraneMissing(result)) {
        return undefined;
      }
      return imageDigest(requireSuccess(`docker inspect ${rendered}`, result));
    },
    copyImage: async (source, target) => {
      const renderedSource = renderDockerRef(source);
      const renderedTarget = renderDockerRef(target);
      requireSuccess(
        `docker copy ${renderedSource} to ${renderedTarget}`,
        await executor.command('crane', [
          'copy',
          renderedSource,
          renderedTarget
        ])
      );
    }
  };
}

function parseJSONString(output: string, description: string): string {
  const trimmed = output.trim();
  if (trimmed === '') {
    throw new Error(`${description} returned empty output`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some npm versions print a bare version without JSON quotes.
    if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(trimmed)) {
      return trimmed;
    }
    throw new Error(`${description} returned invalid JSON: ${output}`);
  }

  if (typeof parsed === 'string') {
    return parsed;
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 1 &&
    typeof parsed[0] === 'string'
  ) {
    return parsed[0];
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'version' in parsed &&
    typeof (parsed as { version: unknown }).version === 'string'
  ) {
    return (parsed as { version: string }).version;
  }
  throw new Error(
    `${description} returned a non-string value: ${JSON.stringify(parsed)}`
  );
}

function parseGitHubRelease(output: string): GitHubReleaseInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`github release returned invalid JSON: ${output}`);
  }
  if (!isRecord(parsed) || typeof parsed.tagName !== 'string') {
    throw new Error('github release response is missing tagName');
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error('github release response is missing assets');
  }
  const assets = parsed.assets.map((asset) => {
    if (!isRecord(asset) || typeof asset.name !== 'string') {
      throw new Error('github release response contains an invalid asset');
    }
    return asset.name;
  });
  return { tagName: versionTag(parsed.tagName), assets };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function renderDockerRef(ref: DockerRef): string {
  return `${ref.repository}:${ref.tag}`;
}

const nodeExecutor: ProcessExecutor = {
  command: async (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr || result.error?.message || ''
    };
  }
};
