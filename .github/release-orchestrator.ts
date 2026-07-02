import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  extractChangelogSection,
  loadDockerImages,
  prereleaseReleaseState,
  stableReleaseState
} from './release-state.ts';
import {
  convergePrereleaseRelease,
  convergeStableRelease,
  ExecCommandRunner,
  verifyPrereleaseRelease,
  verifyStableRelease
} from './release-command-runner.ts';

export type CliArgs =
  | {
      command: 'verify-stable';
      version: string;
      sourceTag: string;
      commitSha: string;
    }
  | {
      command: 'verify-prerelease';
      version: string;
      sourceTag: string;
      npmTag: string;
      dockerAlias?: string;
    }
  | {
      command: 'stable';
      version: string;
      sourceTag: string;
      commitSha: string;
      skipNpm: boolean;
    }
  | {
      command: 'prerelease';
      version: string;
      sourceTag: string;
      npmTag: string;
      dockerAlias?: string;
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
      if (key === '--skip-npm') {
        args.set(key, 'true');
        continue;
      }

      throw new Error(`Missing value for ${key}`);
    }

    args.set(key, value);
    index += 1;
  }

  const version = requireArg(args, '--version');
  const sourceTag = requireArg(args, '--source-tag');

  if (command === 'verify-stable') {
    return {
      command,
      version,
      sourceTag,
      commitSha: requireArg(args, '--commit-sha')
    };
  }

  if (command === 'verify-prerelease' || command === 'prerelease') {
    return {
      command,
      version,
      sourceTag,
      npmTag: requireArg(args, '--npm-tag'),
      dockerAlias: args.get('--docker-alias')
    };
  }

  if (command === 'stable') {
    return {
      command,
      version,
      sourceTag,
      commitSha: requireArg(args, '--commit-sha'),
      skipNpm: args.get('--skip-npm') === 'true'
    };
  }

  throw new Error(
    'Command is required: stable, prerelease, verify-stable, or verify-prerelease'
  );
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const root = process.cwd();
  const images = loadDockerImages(root);
  const runner = new ExecCommandRunner();

  if (cli.command === 'verify-stable') {
    const changelog = readFileSync(
      join(root, 'packages', 'sandbox', 'CHANGELOG.md'),
      'utf8'
    );
    const state = stableReleaseState({
      version: cli.version,
      sourceTag: cli.sourceTag,
      commitSha: cli.commitSha,
      images,
      changelogBody: extractChangelogSection(changelog, cli.version)
    });
    const result = await verifyStableRelease(state, runner);
    reportAndExit(result.missing);
  }

  if (cli.command === 'stable') {
    const changelog = readFileSync(
      join(root, 'packages', 'sandbox', 'CHANGELOG.md'),
      'utf8'
    );
    const state = stableReleaseState({
      version: cli.version,
      sourceTag: cli.sourceTag,
      commitSha: cli.commitSha,
      images,
      changelogBody: extractChangelogSection(changelog, cli.version)
    });
    await convergeStableRelease(state, runner, { skipNpm: cli.skipNpm });
    console.log('Stable release convergence passed');
    process.exit(0);
  }

  if (cli.command === 'verify-prerelease') {
    const state = prereleaseReleaseState({
      version: cli.version,
      sourceTag: cli.sourceTag,
      npmTag: cli.npmTag,
      dockerAlias: cli.dockerAlias,
      images
    });
    const result = await verifyPrereleaseRelease(state, runner);
    reportAndExit(result.missing);
  }

  if (cli.command === 'prerelease') {
    const state = prereleaseReleaseState({
      version: cli.version,
      sourceTag: cli.sourceTag,
      npmTag: cli.npmTag,
      dockerAlias: cli.dockerAlias,
      images
    });
    await convergePrereleaseRelease(state, runner);
    console.log('Prerelease convergence passed');
    process.exit(0);
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
