import { execFileSync } from 'node:child_process';
import type { PrereleaseReleaseState } from './release-state.ts';
import {
  prepareNpmPackage,
  type NpmPrepInput,
  type PreparedNpmPackage
} from './npm-package-prep.ts';

export interface CommandRunner {
  exists(ref: string): Promise<boolean>;
  text(command: string, args: string[]): Promise<string>;
  run(command: string, args: string[]): Promise<void>;
}

export interface VerificationResult {
  ok: boolean;
  missing: string[];
}

export class ExecCommandRunner implements CommandRunner {
  async exists(ref: string): Promise<boolean> {
    const [kind, value] = splitRef(ref);
    try {
      if (kind === 'docker') {
        execFileSync('crane', ['manifest', value], { stdio: 'ignore' });
        return true;
      }
      if (kind === 'npm') {
        execFileSync('npm', ['view', value, 'version'], { stdio: 'ignore' });
        return true;
      }
      if (kind === 'npm-dist-tag') {
        return npmDistTagExists(value);
      }
    } catch {
      return false;
    }
    throw new Error(`Unknown ref kind: ${kind}`);
  }

  async text(command: string, args: string[]): Promise<string> {
    return execFileSync(command, args, { encoding: 'utf8' });
  }

  async run(command: string, args: string[]): Promise<void> {
    execFileSync(command, args, { stdio: 'inherit' });
  }
}

export interface PrereleaseConvergenceOptions {
  skipNpm?: boolean;
  cloudflareAccountId?: string;
  releaseRoot?: string;
  prepareNpmPackage?: NpmPackagePreparer;
}

type NpmPackagePreparer = (input: NpmPrepInput) => Promise<PreparedNpmPackage>;

export async function publishNpmWithPreparedPackage(
  runner: CommandRunner,
  prepared: PreparedNpmPackage,
  packageName: '@cloudflare/sandbox',
  version: string,
  npmTag: string
): Promise<void> {
  if (prepared.packageName !== packageName || prepared.version !== version) {
    await prepared.cleanup();
    throw new Error(
      `Prepared npm package ${prepared.packageName}@${prepared.version} does not match ${packageName}@${version}`
    );
  }

  try {
    await runner.run('npm', [
      'publish',
      prepared.tarballPath,
      '--tag',
      npmTag,
      '--access',
      'public'
    ]);
  } finally {
    await prepared.cleanup();
  }
}

export async function convergePrereleaseRelease(
  state: PrereleaseReleaseState,
  runner: CommandRunner,
  options: PrereleaseConvergenceOptions = {}
): Promise<void> {
  if (!options.skipNpm) {
    if (!(await runner.exists(`npm:${state.npmPackage}@${state.version}`))) {
      const prepare = options.prepareNpmPackage ?? prepareNpmPackage;
      const prepared = await prepare({
        releaseRoot: options.releaseRoot ?? process.cwd(),
        packageName: '@cloudflare/sandbox',
        version: state.version,
        versionOverride: state.version
      });
      await publishNpmWithPreparedPackage(
        runner,
        prepared,
        state.npmPackage,
        state.version,
        state.npmTag
      );
    }

    if (
      !(await runner.exists(`npm-dist-tag:${state.npmTag}=${state.version}`))
    ) {
      await runner.run('npm', [
        'dist-tag',
        'add',
        `${state.npmPackage}@${state.version}`,
        state.npmTag
      ]);
    }
  }

  const resolveSourceRef = createSourceRefResolver(options.cloudflareAccountId);
  for (const mapping of state.dockerTags) {
    let sourceRef: string | undefined;
    const resolvedSourceRef = (): string => {
      sourceRef ??= resolveSourceRef(mapping.sourceRef);
      return sourceRef;
    };

    if (!(await runner.exists(`docker:${mapping.dockerHubRef}`))) {
      await runner.run('crane', [
        'copy',
        resolvedSourceRef(),
        mapping.dockerHubRef
      ]);
    }
    if (!(await runner.exists(`docker:${mapping.cfLibraryRef}`))) {
      await runner.run('crane', [
        'copy',
        resolvedSourceRef(),
        mapping.cfLibraryRef
      ]);
    }
    if (mapping.aliasTag !== undefined) {
      await runner.run('crane', [
        'copy',
        resolvedSourceRef(),
        `docker.io/cloudflare/sandbox:${mapping.aliasTag}`
      ]);
      await runner.run('crane', [
        'copy',
        resolvedSourceRef(),
        `registry.cloudflare.com/library/sandbox:${mapping.aliasTag}`
      ]);
    }
  }

  const result = await verifyPrereleaseRelease(state, runner);
  if (!result.ok) {
    throw new Error(
      `Prerelease convergence failed. Missing artifacts:\n${result.missing.join('\n')}`
    );
  }
}

export async function verifyPrereleaseRelease(
  state: PrereleaseReleaseState,
  runner: CommandRunner
): Promise<VerificationResult> {
  const dockerRefs = state.dockerTags.flatMap((mapping) => {
    const refs = [
      `docker:${mapping.dockerHubRef}`,
      `docker:${mapping.cfLibraryRef}`
    ];
    if (mapping.aliasTag !== undefined) {
      refs.push(`docker:docker.io/cloudflare/sandbox:${mapping.aliasTag}`);
      refs.push(
        `docker:registry.cloudflare.com/library/sandbox:${mapping.aliasTag}`
      );
    }
    return refs;
  });

  return verifyRefs(
    [
      `npm:${state.npmPackage}@${state.version}`,
      `npm-dist-tag:${state.npmTag}=${state.version}`,
      ...dockerRefs
    ],
    runner
  );
}

export function createSourceRefResolver(
  cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
): (sourceRef: string) => string {
  return (sourceRef: string) => {
    const accountID = cloudflareAccountId?.trim();
    if (accountID === undefined || accountID.length === 0) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID is required to resolve Docker source image refs'
      );
    }
    return sourceRef.replace('$CLOUDFLARE_ACCOUNT_ID', accountID);
  };
}

async function verifyRefs(
  refs: string[],
  runner: CommandRunner
): Promise<VerificationResult> {
  const missing: string[] = [];
  for (const ref of refs) {
    if (!(await runner.exists(ref))) {
      missing.push(ref);
    }
  }
  return { ok: missing.length === 0, missing };
}

function splitRef(ref: string): [string, string] {
  const index = ref.indexOf(':');
  if (index === -1) {
    throw new Error(`Invalid ref: ${ref}`);
  }
  return [ref.slice(0, index), ref.slice(index + 1)];
}

function npmDistTagExists(value: string): boolean {
  const [tag, version] = splitDistTagRef(value);
  const output = execFileSync(
    'npm',
    ['dist-tag', 'ls', '@cloudflare/sandbox'],
    { encoding: 'utf8' }
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === `${tag}: ${version}`);
}

function splitDistTagRef(value: string): [string, string] {
  const index = value.indexOf('=');
  if (index === -1) {
    throw new Error(`Invalid npm dist-tag ref: ${value}`);
  }
  return [value.slice(0, index), value.slice(index + 1)];
}
