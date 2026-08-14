import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { commitSHA, stableVersion } from './release-primitives.ts';
import { computePromotionEdits } from './promotion-plan.ts';

export interface PromotionWorktreeInput {
  version: string;
  mainSHA: string;
}

export interface PromotionWorktreeDeps {
  createWorktree(mainSHA: string): Promise<string>;
  removeWorktree(path: string): Promise<void>;
  promotionTargets(root: string): string[];
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  git(args: string[], options: { cwd: string }): Promise<string>;
  upsertPR(version: string, branch: string): Promise<string>;
}

export interface PromotionWorktreeResult {
  status: 'no-edits' | 'pr-created';
  branch?: string;
}

export function promotionTargets(root: string): string[] {
  const dockerfiles = fg.sync(
    ['examples/*/Dockerfile', 'bridge/worker/Dockerfile'],
    { cwd: root, absolute: true }
  );
  const docs = [
    'DOCKER_README.md',
    'bridge/worker/README.md',
    'examples/codex-app-server/README.md'
  ].map((path) => join(root, path));

  return [...dockerfiles, ...docs].sort();
}

export async function runPromotionInWorktree(
  input: PromotionWorktreeInput,
  deps: PromotionWorktreeDeps
): Promise<PromotionWorktreeResult> {
  const version = stableVersion(input.version);
  const mainSHA = commitSHA(input.mainSHA);
  const root = await deps.createWorktree(mainSHA);
  try {
    const head = (await deps.git(['rev-parse', 'HEAD'], { cwd: root })).trim();
    if (head !== mainSHA) {
      throw new Error(
        `Promotion worktree HEAD ${head} does not match requested mainSHA ${mainSHA}`
      );
    }

    const targets = deps.promotionTargets(root);
    for (const path of targets) relativePromotionPath(root, path);
    const edits = computePromotionEdits(
      targets.map((path) => ({ path, content: deps.readFile(path) })),
      version
    );
    if (edits.length === 0) return { status: 'no-edits' };

    const relativePaths = edits
      .map((edit) => relativePromotionPath(root, edit.path))
      .sort();
    for (const edit of edits) deps.writeFile(edit.path, edit.content);
    await deps.git(['add', '--', ...relativePaths], { cwd: root });
    const staged = (
      await deps.git(['diff', '--cached', '--name-only'], { cwd: root })
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
    assertExactStagedPaths(relativePaths, staged);

    const branch = `promote/${version}`;
    await deps.git(['commit', '-m', `Promote public refs to ${version}`], {
      cwd: root
    });
    await deps.git(
      ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`],
      { cwd: root }
    );
    await deps.upsertPR(version, branch);
    return { status: 'pr-created', branch };
  } finally {
    await deps.removeWorktree(root);
  }
}

export function assertExactStagedPaths(
  expected: readonly string[],
  actual: readonly string[]
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const path of actualSet) {
    if (!expectedSet.has(path)) {
      throw new Error(`Unexpected staged promotion path: ${path}`);
    }
  }
  for (const path of expectedSet) {
    if (!actualSet.has(path)) {
      throw new Error(`Expected promotion path not staged: ${path}`);
    }
  }
}

function relativePromotionPath(root: string, path: string): string {
  const relativePath = relative(root, path);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Promotion path escapes worktree: ${path}`);
  }
  return relativePath;
}

function parsePromotionArgs(argv: readonly string[]): PromotionWorktreeInput {
  const allowed = new Set(['--version', '--main-sha']);
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      args.has(key)
    ) {
      throw new Error(`Invalid promotion arguments near: ${key ?? '(end)'}`);
    }
    args.set(key, value);
  }
  const version = args.get('--version');
  const mainSHA = args.get('--main-sha');
  if (version === undefined || mainSHA === undefined) {
    throw new Error('--version and --main-sha are required');
  }
  return { version, mainSHA };
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string } = {}
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'cloudflare-sandbox-release[bot]',
      GIT_AUTHOR_EMAIL:
        'cloudflare-sandbox-release[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'cloudflare-sandbox-release[bot]',
      GIT_COMMITTER_EMAIL:
        'cloudflare-sandbox-release[bot]@users.noreply.github.com'
    }
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message || ''}`
    );
  }
  return result.stdout;
}

const nodePromotionDeps: PromotionWorktreeDeps = {
  createWorktree: async (mainSHA) => {
    const parent = mkdtempSync(join(tmpdir(), 'sandbox-promotion-'));
    const root = join(parent, 'worktree');
    try {
      run('git', ['worktree', 'add', '--detach', root, mainSHA]);
      return root;
    } catch (error) {
      rmSync(parent, { recursive: true, force: true });
      throw error;
    }
  },
  removeWorktree: async (path) => {
    try {
      run('git', ['worktree', 'remove', '--force', path]);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  },
  promotionTargets,
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  git: async (args, options) => run('git', args, options),
  upsertPR: async (version, branch) => {
    let url = run('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--base',
      'main',
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url'
    ]).trim();
    if (url.length === 0) {
      url = run('gh', [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        'main',
        '--title',
        `Promote public references to ${version}`,
        '--body',
        `Advance example and documentation Docker image references to \`${version}\` after full stable release verification.`
      ]).trim();
    }
    run('gh', ['pr', 'merge', branch, '--auto', '--squash']);
    return url;
  }
};

async function main(): Promise<void> {
  const result = await runPromotionInWorktree(
    parsePromotionArgs(process.argv.slice(2)),
    nodePromotionDeps
  );
  console.log(`promotion_result=${result.status}`);
  if (result.branch !== undefined) {
    console.log(`promotion_branch=${result.branch}`);
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
