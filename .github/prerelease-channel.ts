import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type BaseBump = 'major' | 'minor' | 'patch';

export interface ComputePrereleaseVersionOptions {
  baseVersion: string;
  baseBump: BaseBump;
  prereleaseIdentifier: string;
  runNumber: string;
  runAttempt: string;
}

interface CliOptions {
  command: 'apply' | 'compute';
  baseBump: BaseBump;
  baseVersion?: string;
  channel: string;
  githubOutput?: string;
  prereleaseIdentifier: string;
  root: string;
  runAttempt: string;
  runNumber: string;
  version?: string;
}

export function parseChannel(value: string): string {
  if (value.length === 0) {
    throw new Error('Prerelease channel is required');
  }
  if (!/^[0-9A-Za-z-]+$/.test(value)) {
    throw new Error(
      `Prerelease channel "${value}" must only contain letters, numbers, and hyphens`
    );
  }
  return value;
}

export function parseBaseBump(value: string): BaseBump {
  if (value === 'major' || value === 'minor' || value === 'patch') {
    return value;
  }
  throw new Error(`Base bump "${value}" must be one of: major, minor, patch`);
}

export function computePrereleaseVersion({
  baseVersion,
  baseBump,
  prereleaseIdentifier,
  runNumber,
  runAttempt
}: ComputePrereleaseVersionOptions): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(baseVersion);
  if (!match) {
    throw new Error(
      `Base version "${baseVersion}" must be a valid semver version`
    );
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  if (baseBump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (baseBump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  const identifier = parseChannel(prereleaseIdentifier);
  const run = parseNumericIdentifier(runNumber, 'GitHub run number');
  const attempt = parseNumericIdentifier(runAttempt, 'GitHub run attempt');

  return `${major}.${minor}.${patch}-${identifier}.${run}.${attempt}`;
}

export function applyPackageVersion(root: string, version: string): void {
  const packageJsonPath = join(root, 'packages', 'sandbox', 'package.json');
  const versionSourcePath = join(
    root,
    'packages',
    'sandbox',
    'src',
    'version.ts'
  );

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: string;
  };
  packageJson.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const versionSource = readFileSync(versionSourcePath, 'utf8');
  const nextVersionSource = versionSource.replace(
    /export const SDK_VERSION = '[^']+';/,
    `export const SDK_VERSION = '${version}';`
  );
  if (nextVersionSource === versionSource) {
    throw new Error(
      `Could not find SDK_VERSION export in ${versionSourcePath}`
    );
  }
  writeFileSync(versionSourcePath, nextVersionSource);
}

function parseNumericIdentifier(value: string, label: string): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} "${value}" must be a non-negative integer`);
  }
  return value;
}

function readPackageVersion(root: string): string {
  const packageJsonPath = join(root, 'packages', 'sandbox', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: string;
  };
  if (!packageJson.version) {
    throw new Error(`${packageJsonPath} does not contain a version`);
  }
  return packageJson.version;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const args = new Map<string, string>();
  let command: CliOptions['command'] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === 'compute' || value === 'apply') {
      command = value;
      continue;
    }
    if (!value.startsWith('--')) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, next);
    index += 1;
  }

  if (!command) {
    throw new Error('Command is required: compute or apply');
  }

  const root = args.get('root') ?? process.cwd();
  const channel = parseChannel(
    args.get('channel') ?? env.PRERELEASE_CHANNEL ?? 'next'
  );
  const prereleaseIdentifier = parseChannel(
    args.get('prerelease-identifier') ?? env.PRERELEASE_IDENTIFIER ?? channel
  );

  return {
    command,
    baseBump: parseBaseBump(args.get('base-bump') ?? env.BASE_BUMP ?? 'patch'),
    baseVersion: args.get('base-version') ?? env.BASE_VERSION,
    channel,
    githubOutput: args.get('github-output') ?? env.GITHUB_OUTPUT,
    prereleaseIdentifier,
    root,
    runAttempt: args.get('run-attempt') ?? env.GITHUB_RUN_ATTEMPT ?? '1',
    runNumber: args.get('run-number') ?? env.GITHUB_RUN_NUMBER ?? '0',
    version: args.get('version') ?? env.PRERELEASE_VERSION
  };
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2), process.env);
  const version =
    options.version ??
    computePrereleaseVersion({
      baseVersion: options.baseVersion ?? readPackageVersion(options.root),
      baseBump: options.baseBump,
      prereleaseIdentifier: options.prereleaseIdentifier,
      runNumber: options.runNumber,
      runAttempt: options.runAttempt
    });

  if (options.command === 'apply') {
    applyPackageVersion(options.root, version);
  }

  if (options.githubOutput) {
    appendFileSync(options.githubOutput, `version=${version}\n`);
    appendFileSync(options.githubOutput, `channel=${options.channel}\n`);
  }

  console.log(version);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
