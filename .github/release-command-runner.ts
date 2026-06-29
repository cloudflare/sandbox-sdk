import { execFileSync } from 'node:child_process';
import type {
  PrereleaseReleaseState,
  StableReleaseState
} from './release-state.ts';

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

      if (kind === 'git-tag') {
        execFileSync('git', ['rev-parse', '--verify', `refs/tags/${value}`], {
          stdio: 'ignore'
        });
        return true;
      }

      if (kind === 'github-release') {
        execFileSync('gh', ['release', 'view', value], { stdio: 'ignore' });
        return true;
      }

      if (kind === 'github-release-tag') {
        return githubReleaseTagMatches(value);
      }

      if (kind === 'github-asset') {
        return githubAssetExists(value);
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

export class FakeCommandRunner implements CommandRunner {
  readonly commands: string[][] = [];

  constructor(
    private readonly options: {
      presentRefs: Set<string>;
      textByCommand?: Map<string, string>;
    }
  ) {}

  async exists(ref: string): Promise<boolean> {
    return this.options.presentRefs.has(ref);
  }

  async text(command: string, args: string[]): Promise<string> {
    this.commands.push([command, ...args]);
    return this.options.textByCommand?.get([command, ...args].join(' ')) ?? '';
  }

  async run(command: string, args: string[]): Promise<void> {
    this.commands.push([command, ...args]);
    this.recordCreatedRef(command, args);
  }

  private recordCreatedRef(command: string, args: string[]): void {
    if (command === 'crane' && args[0] === 'copy') {
      this.options.presentRefs.add(`docker:${args[2]}`);
      return;
    }

    if (command === 'npm' && args[0] === 'dist-tag' && args[1] === 'add') {
      const [pkg, version] = args[2].split('@').filter(Boolean);
      const packageVersion = version ?? pkg;
      this.options.presentRefs.add(`npm:@cloudflare/sandbox@${packageVersion}`);
      this.options.presentRefs.add(`npm-dist-tag:${args[3]}=${packageVersion}`);
      return;
    }

    if (command === 'git' && args[0] === 'tag' && args[1] === '-a') {
      this.options.presentRefs.add(`git-tag:${args[2]}`);
      return;
    }

    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      this.options.presentRefs.add(`github-release:${args[2]}`);
      this.options.presentRefs.add(`github-release-tag:${args[2]}=${args[2]}`);
      return;
    }

    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      const releaseName = args[2];
      for (const asset of args.slice(3).filter((arg) => arg !== '--clobber')) {
        this.options.presentRefs.add(
          `github-asset:${releaseName}:${asset.replace(/^\.\//, '')}`
        );
      }
    }
  }
}

export interface StableConvergenceOptions {
  skipNpm?: boolean;
  cloudflareAccountId?: string;
}

export interface PrereleaseConvergenceOptions {
  skipNpm?: boolean;
  cloudflareAccountId?: string;
}

export async function convergePrereleaseRelease(
  state: PrereleaseReleaseState,
  runner: CommandRunner,
  options: PrereleaseConvergenceOptions = {}
): Promise<void> {
  if (!options.skipNpm) {
    if (!(await runner.exists(`npm:${state.npmPackage}@${state.version}`))) {
      await runner.run('npx', ['tsx', '.github/resolve-workspace-versions.ts']);
      await runner.run('npm', [
        'publish',
        './packages/sandbox',
        '--tag',
        state.npmTag,
        '--access',
        'public'
      ]);
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

export async function convergeStableRelease(
  state: StableReleaseState,
  runner: CommandRunner,
  options: StableConvergenceOptions = {}
): Promise<void> {
  if (!options.skipNpm) {
    if (!(await runner.exists(`npm:${state.npmPackage}@${state.version}`))) {
      await runner.run('npx', ['tsx', '.github/resolve-workspace-versions.ts']);
      await runner.run('npm', [
        'publish',
        './packages/sandbox',
        '--access',
        'public'
      ]);
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

  await convergeGitTag(state, runner);
  await convergeGitHubRelease(state, runner);

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
  }

  const missingAssets: string[] = [];
  for (const asset of state.releaseAssets) {
    if (
      !(await runner.exists(`github-asset:${state.githubReleaseName}:${asset}`))
    ) {
      missingAssets.push(asset);
    }
  }

  if (missingAssets.length > 0) {
    await extractStableReleaseAssets(
      state,
      runner,
      createSourceRefResolver(options.cloudflareAccountId)
    );

    await runner.run('gh', [
      'release',
      'upload',
      state.githubReleaseName,
      ...missingAssets.flatMap((asset) => [`./${asset}`]),
      '--clobber'
    ]);
  }

  const result = await verifyStableRelease(state, runner);
  if (!result.ok) {
    throw new Error(
      `Stable release convergence failed. Missing artifacts:\n${result.missing.join('\n')}`
    );
  }
}

export async function verifyStableRelease(
  state: StableReleaseState,
  runner: CommandRunner
): Promise<VerificationResult> {
  const refs = [
    `npm:${state.npmPackage}@${state.version}`,
    `npm-dist-tag:${state.npmTag}=${state.version}`,
    `git-tag:${state.gitTag}`,
    `github-release:${state.githubReleaseName}`,
    `github-release-tag:${state.githubReleaseName}=${state.gitTag}`,
    ...state.dockerTags.flatMap((mapping) => [
      `docker:${mapping.dockerHubRef}`,
      `docker:${mapping.cfLibraryRef}`
    ]),
    ...state.releaseAssets.map(
      (asset) => `github-asset:${state.githubReleaseName}:${asset}`
    )
  ];

  return verifyRefs(refs, runner);
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

async function convergeGitTag(
  state: StableReleaseState,
  runner: CommandRunner
): Promise<void> {
  if (await runner.exists(`git-tag:${state.gitTag}`)) {
    const taggedCommit = (
      await runner.text('git', ['rev-list', '-n', '1', state.gitTag])
    ).trim();

    if (taggedCommit.length > 0 && taggedCommit !== state.commitSha) {
      throw new Error(
        `Git tag ${state.gitTag} points to ${taggedCommit}, expected ${state.commitSha}`
      );
    }
    return;
  }

  await runner.run('git', [
    'tag',
    '-a',
    state.gitTag,
    state.commitSha,
    '-m',
    state.gitTag
  ]);
  await runner.run('git', ['push', 'origin', state.gitTag]);
}

async function extractStableReleaseAssets(
  state: StableReleaseState,
  runner: CommandRunner,
  resolveSourceRef: (sourceRef: string) => string
): Promise<void> {
  const normal = requiredDockerMapping(state, 'sandbox');
  const musl = requiredDockerMapping(state, 'sandbox-musl');

  await extractStableReleaseAsset(
    runner,
    resolveSourceRef(normal.sourceRef),
    './sandbox-linux-x64'
  );
  await extractStableReleaseAsset(
    runner,
    resolveSourceRef(musl.sourceRef),
    './sandbox-linux-x64-musl'
  );
  await runner.run('sh', [
    '-c',
    'sha256sum sandbox-linux-x64 > sandbox-linux-x64.sha256'
  ]);
  await runner.run('sh', [
    '-c',
    'sha256sum sandbox-linux-x64-musl > sandbox-linux-x64-musl.sha256'
  ]);
}

async function extractStableReleaseAsset(
  runner: CommandRunner,
  sourceRef: string,
  outputPath: string
): Promise<void> {
  await runner.run('docker', ['pull', sourceRef]);
  const containerId = (
    await runner.text('docker', ['create', sourceRef])
  ).trim();
  await runner.run('docker', [
    'cp',
    `${containerId}:/container-server/sandbox`,
    outputPath
  ]);
  await runner.run('docker', ['rm', containerId]);
}

function createSourceRefResolver(
  cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
): (sourceRef: string) => string {
  return (sourceRef: string) => {
    const accountId = cloudflareAccountId?.trim();

    if (accountId === undefined || accountId.length === 0) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID is required to resolve Docker source image refs'
      );
    }

    return sourceRef.replace('$CLOUDFLARE_ACCOUNT_ID', accountId);
  };
}

function requiredDockerMapping(
  state: StableReleaseState,
  image: string
): StableReleaseState['dockerTags'][number] {
  const mapping = state.dockerTags.find((item) => item.image === image);

  if (mapping === undefined) {
    throw new Error(`Stable release assets require Docker image: ${image}`);
  }

  return mapping;
}

async function convergeGitHubRelease(
  state: StableReleaseState,
  runner: CommandRunner
): Promise<void> {
  if (await runner.exists(`github-release:${state.githubReleaseName}`)) {
    if (
      !(await runner.exists(
        `github-release-tag:${state.githubReleaseName}=${state.gitTag}`
      ))
    ) {
      throw new Error(
        `GitHub Release ${state.githubReleaseName} is not attached to expected tag ${state.gitTag}`
      );
    }
    return;
  }

  await runner.run('gh', [
    'release',
    'create',
    state.githubReleaseName,
    '--target',
    state.commitSha,
    '--title',
    state.githubReleaseName,
    '--notes',
    state.changelogBody
  ]);
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
    {
      encoding: 'utf8'
    }
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

function githubReleaseTagMatches(value: string): boolean {
  const [releaseName, tagName] = splitGitHubReleaseTagRef(value);
  const output = execFileSync(
    'gh',
    ['release', 'view', releaseName, '--json', 'tagName', '--jq', '.tagName'],
    { encoding: 'utf8' }
  );

  return output.trim() === tagName;
}

function githubAssetExists(value: string): boolean {
  const [releaseName, assetName] = splitGitHubAssetRef(value);
  const output = execFileSync(
    'gh',
    [
      'release',
      'view',
      releaseName,
      '--json',
      'assets',
      '--jq',
      '.assets[].name'
    ],
    { encoding: 'utf8' }
  );

  return output
    .split('\n')
    .map((line) => line.trim())
    .includes(assetName);
}

function splitGitHubAssetRef(value: string): [string, string] {
  const index = value.lastIndexOf(':');

  if (index === -1) {
    throw new Error(`Invalid GitHub asset ref: ${value}`);
  }

  return [value.slice(0, index), value.slice(index + 1)];
}

function splitGitHubReleaseTagRef(value: string): [string, string] {
  const index = value.lastIndexOf('=');

  if (index === -1) {
    throw new Error(`Invalid GitHub release tag ref: ${value}`);
  }

  return [value.slice(0, index), value.slice(index + 1)];
}
