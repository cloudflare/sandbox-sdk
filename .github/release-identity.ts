import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  commitSHA,
  sourceTag,
  stableVersion,
  versionTag
} from './release-primitives.ts';
import type { ReleaseMode } from './stable-release-context.ts';

const SEMVER = /^\d+\.\d+\.\d+$/;

export interface ReleaseIdentityInputs {
  version: string;
  tagSHA: string | null;
  npmVersionExists: boolean;
  githubSHA: string;
}

export interface ReleaseIdentity {
  version: string;
  releaseSHA: string;
  recovered: boolean;
}

export interface StableIdentityInput {
  version: string;
  selector: string;
  triggerSHA: string;
}

export interface StableIdentityDeps {
  resolveRef(ref: string): Promise<string>;
  tagSHA(tag: string): Promise<string | undefined>;
  npmVersionExists(packageVersion: string): Promise<boolean>;
  currentMainSHA(): Promise<string>;
  deriveSourceTag(releaseSHA: string): Promise<string>;
}

interface StableIdentityArgs {
  version: string;
  selector: string;
}

export async function deriveStableReleaseIdentity(
  input: StableIdentityInput,
  deps: StableIdentityDeps
) {
  const version = stableVersion(input.version);
  const tag = versionTag(`@cloudflare/sandbox@${version}`);
  const existingTagSHA = await deps.tagSHA(tag);
  if (
    existingTagSHA === undefined &&
    (await deps.npmVersionExists(`@cloudflare/sandbox@${version}`))
  ) {
    throw new Error(
      `npm has @cloudflare/sandbox@${version} but ${tag} tag is missing`
    );
  }
  const releaseSHA = commitSHA(existingTagSHA ?? input.triggerSHA);
  const mainSHA = commitSHA(await deps.currentMainSHA());
  const mode: ReleaseMode = releaseSHA === mainSHA ? 'current' : 'historical';
  return {
    version,
    releaseSHA,
    sourceTag: sourceTag(await deps.deriveSourceTag(releaseSHA)),
    versionTag: tag,
    mode
  };
}

export async function runStableIdentityCli(
  argv: readonly string[],
  deps: StableIdentityDeps = nodeStableIdentityDeps
): Promise<string> {
  const args = parseStableIdentityArgs(argv);
  const triggerSHA = await deps.resolveRef(args.selector);
  const identity = await deriveStableReleaseIdentity(
    { version: args.version, selector: args.selector, triggerSHA },
    deps
  );
  return (
    [
      `release-sha=${identity.releaseSHA}`,
      `release-mode=${identity.mode}`
    ].join('\n') + '\n'
  );
}

function parseStableIdentityArgs(argv: readonly string[]): StableIdentityArgs {
  if (argv[0] !== 'stable') {
    throw new Error('Identity command is required: stable');
  }
  const values = new Map<string, string>();
  const allowedOptions = new Set(['--version', '--selector']);
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`Invalid identity arguments near: ${key ?? '(end)'}`);
    }
    if (!allowedOptions.has(key)) {
      throw new Error(`Unknown identity option: ${key}`);
    }
    values.set(key, value);
  }
  const version = values.get('--version');
  const selector = values.get('--selector');
  if (version === undefined || selector === undefined) {
    throw new Error('--version and --selector are required');
  }
  return { version, selector };
}

const nodeStableIdentityDeps: StableIdentityDeps = {
  resolveRef: async (ref) => commandText('git', ['rev-parse', ref]),
  tagSHA: async (tag) => {
    const output = commandText('git', [
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`
    ]);
    const refs = output
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/, 2));
    return (
      refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0] ??
      refs.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0]
    );
  },
  npmVersionExists: async (packageVersion) => {
    const result = spawnSync('npm', npmVersionViewArgs(packageVersion), {
      encoding: 'utf8'
    });
    if (result.status === 0) {
      return true;
    }
    if (/\bE404\b|is not in this registry/.test(result.stderr)) {
      return false;
    }
    throw new Error(
      `npm view ${packageVersion} failed: ${result.stderr || result.error?.message || ''}`
    );
  },
  currentMainSHA: async () => commandText('git', ['rev-parse', 'origin/main']),
  deriveSourceTag: async (releaseSHA) => `ci-${releaseSHA}`
};

function commandText(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message || ''}`
    );
  }
  return result.stdout.trim();
}

export function chooseReleaseIdentity(
  inputs: ReleaseIdentityInputs
): ReleaseIdentity {
  if (!SEMVER.test(inputs.version)) {
    throw new Error(`Malformed release version: ${inputs.version}`);
  }

  const tagSHA = inputs.tagSHA?.trim() ?? '';
  if (tagSHA.length > 0) {
    return {
      version: inputs.version,
      releaseSHA: tagSHA,
      recovered: tagSHA !== inputs.githubSHA.trim()
    };
  }

  if (inputs.npmVersionExists) {
    throw new Error(
      `Refusing to release ${inputs.version}: npm already publishes this version but its git tag is missing`
    );
  }

  const githubSHA = inputs.githubSHA.trim();
  if (githubSHA.length === 0) {
    throw new Error('Release commit sha is empty');
  }

  return { version: inputs.version, releaseSHA: githubSHA, recovered: false };
}

function tagSHAFromGit(gitTag: string): string | null {
  try {
    const sha = execFileSync('git', ['rev-list', '-n', '1', gitTag], {
      encoding: 'utf8'
    }).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function npmVersionExistsCheck(version: string): boolean {
  try {
    execFileSync('npm', npmVersionViewArgs(`@cloudflare/sandbox@${version}`), {
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

export function npmVersionViewArgs(packageVersion: string): string[] {
  return ['view', packageVersion, 'version', '--prefer-online'];
}

function runLegacyIdentityCli(): string {
  const version = process.env.RELEASE_VERSION?.trim() ?? '';
  const githubSHA = process.env.GITHUB_SHA?.trim() ?? '';
  const gitTag = `@cloudflare/sandbox@${version}`;

  const identity = chooseReleaseIdentity({
    version,
    tagSHA: tagSHAFromGit(gitTag),
    npmVersionExists: npmVersionExistsCheck(version),
    githubSHA
  });

  return (
    [
      `version=${identity.version}`,
      `release_sha=${identity.releaseSHA}`,
      `recovered=${identity.recovered}`
    ].join('\n') + '\n'
  );
}

async function main(): Promise<void> {
  const stableCommand = process.argv[2] === 'stable';
  const lines = stableCommand
    ? await runStableIdentityCli(process.argv.slice(2))
    : runLegacyIdentityCli();
  const output = process.env.GITHUB_OUTPUT;
  if (!stableCommand && output !== undefined && output.length > 0) {
    appendFileSync(output, lines);
  } else {
    process.stdout.write(lines);
  }
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
