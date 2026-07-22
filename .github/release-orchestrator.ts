import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDockerImages, prereleaseReleaseState } from './release-state.ts';
import {
  convergePrereleaseRelease,
  ExecCommandRunner,
  verifyPrereleaseRelease
} from './release-command-runner.ts';
import {
  createStableReleaseContext,
  type ReleaseMode,
  type StableReleaseContext,
  type StableReleaseContextDeps
} from './stable-release-context.ts';
import { prepareStableRelease } from './stable-release-preparation.ts';
import { ExecReleasePlatform } from './release-platform.ts';
import {
  inspectStableReleasePlan,
  runStableReleaseEngine
} from './stable-release-engine.ts';

interface StableCliArgs {
  command: 'stable' | 'inspect-stable';
  version: string;
  sourceTag: string;
  commitSha: string;
  releaseRoot?: string;
  mode: ReleaseMode;
}

export type CliArgs =
  | StableCliArgs
  | {
      command: 'verify-prerelease';
      version: string;
      sourceTag: string;
      npmTag: string;
      dockerAlias?: string;
      releaseRoot?: string;
    }
  | {
      command: 'prerelease';
      version: string;
      sourceTag: string;
      npmTag: string;
      dockerAlias?: string;
      releaseRoot?: string;
    };

export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0];
  const args = new Map<string, string>();

  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    args.set(key, value);
    index += 1;
  }

  const allowedArgs = allowedArgsForCommand(command);
  assertAllowedArgs(args, allowedArgs, command);

  const version = requireArg(args, '--version');
  const sourceTag = requireArg(args, '--source-tag');

  if (command === 'stable' || command === 'inspect-stable') {
    const releaseRoot = args.get('--release-root');
    return {
      command,
      version,
      sourceTag,
      commitSha: requireArg(args, '--commit-sha'),
      mode: parseReleaseMode(requireArg(args, '--mode')),
      ...(releaseRoot !== undefined ? { releaseRoot } : {})
    };
  }

  if (command === 'verify-prerelease' || command === 'prerelease') {
    const releaseRoot = args.get('--release-root');
    return {
      command,
      version,
      sourceTag,
      npmTag: requireArg(args, '--npm-tag'),
      dockerAlias: args.get('--docker-alias'),
      ...(releaseRoot !== undefined ? { releaseRoot } : {})
    };
  }

  throw new Error('Unreachable command');
}

export function isStablePlanIncomplete(plan: {
  readonly operations: readonly unknown[];
  readonly conflicts: readonly string[];
}): boolean {
  return plan.operations.length > 0 || plan.conflicts.length > 0;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const root = process.cwd();
  const releaseRoot = cli.releaseRoot ?? root;

  if (cli.command === 'stable' || cli.command === 'inspect-stable') {
    const context = await createNodeStableContext({
      version: cli.version,
      releaseSHA: cli.commitSha,
      releaseRoot,
      sourceTag: cli.sourceTag,
      mode: cli.mode
    });
    const platform = new ExecReleasePlatform();
    const prepare = () => prepareStableRelease(context);

    if (cli.command === 'inspect-stable') {
      const plan = await inspectStableReleasePlan({
        context,
        platform,
        prepare
      });
      console.log(plan.summary);
      if (isStablePlanIncomplete(plan)) {
        process.exitCode = 1;
      }
      return;
    }

    await runStableReleaseEngine({ context, platform, prepare });
    console.log(
      `Stable release engine completed for ${cli.version} at ${cli.commitSha}`
    );
    return;
  }

  if (cli.command === 'verify-prerelease' || cli.command === 'prerelease') {
    const images = loadDockerImages(root);
    const runner = new ExecCommandRunner();
    const state = prereleaseReleaseState({
      version: cli.version,
      sourceTag: cli.sourceTag,
      npmTag: cli.npmTag,
      dockerAlias: cli.dockerAlias,
      images
    });

    if (cli.command === 'verify-prerelease') {
      const result = await verifyPrereleaseRelease(state, runner);
      reportAndExit(result.missing);
    }

    await convergePrereleaseRelease(state, runner, { releaseRoot });
    console.log('Prerelease convergence passed');
    return;
  }
}

async function createNodeStableContext(input: {
  version: string;
  releaseSHA: string;
  releaseRoot: string;
  sourceTag: string;
  mode: ReleaseMode;
}): Promise<StableReleaseContext> {
  const context = await createStableReleaseContext(
    input,
    nodeStableContextDeps
  );
  const accountID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (accountID === undefined || accountID.length === 0) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required for stable releases');
  }
  return Object.freeze({
    ...context,
    dockerImages: context.dockerImages.map((image) => ({
      ...image,
      sourceRef: image.sourceRef.replace('$CLOUDFLARE_ACCOUNT_ID', accountID)
    }))
  });
}

const nodeStableContextDeps: StableReleaseContextDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  commandText: async (command, args, options) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message || ''}`
      );
    }
    return result.stdout;
  }
};

function parseReleaseMode(value: string): ReleaseMode {
  if (value !== 'current' && value !== 'historical') {
    throw new Error('--mode must be current or historical');
  }
  return value;
}

function allowedArgsForCommand(
  command: string | undefined
): ReadonlySet<string> {
  if (command === 'stable' || command === 'inspect-stable') {
    return new Set([
      '--version',
      '--source-tag',
      '--commit-sha',
      '--release-root',
      '--mode'
    ]);
  }
  if (command === 'verify-prerelease' || command === 'prerelease') {
    return new Set([
      '--version',
      '--source-tag',
      '--npm-tag',
      '--docker-alias',
      '--release-root'
    ]);
  }
  throw new Error(
    'Command is required: stable, inspect-stable, prerelease, or verify-prerelease'
  );
}

function assertAllowedArgs(
  args: ReadonlyMap<string, string>,
  allowedArgs: ReadonlySet<string>,
  command: string | undefined
): void {
  for (const key of args.keys()) {
    if (!allowedArgs.has(key)) {
      throw new Error(`Option ${key} is not valid for ${command}`);
    }
  }
}

function requireArg(args: Map<string, string>, key: string): string {
  const value = args.get(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function reportAndExit(missing: string[]): never {
  if (missing.length === 0) {
    console.log('Release verification passed');
    process.exit(0);
  }
  console.error('Release verification failed. Missing artifacts:');
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
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
