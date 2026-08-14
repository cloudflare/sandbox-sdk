import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExactStagedPaths,
  runPromotionInWorktree
} from './promote-references.ts';

const MAIN_SHA = '0123456789abcdef0123456789abcdef01234567';

describe('runPromotionInWorktree', () => {
  test('scenario promotion PR creation returns pr-created and stops workflow caller', async () => {
    const result = await runPromotionInWorktree(
      { version: '1.2.3', mainSHA: MAIN_SHA },
      promotionDepsWithContent('FROM docker.io/cloudflare/sandbox:1.2.2\n')
    );

    assert.deepEqual(result, {
      status: 'pr-created',
      branch: 'promote/1.2.3'
    });
  });

  test('scenario promotion after merge observes no edits on current main worktree', async () => {
    const result = await runPromotionInWorktree(
      { version: '1.2.3', mainSHA: MAIN_SHA },
      promotionDepsWithContent('FROM docker.io/cloudflare/sandbox:1.2.3\n')
    );

    assert.deepEqual(result, { status: 'no-edits' });
  });

  test('stages only allowlisted paths and rejects extra staged paths', async () => {
    const gitCalls: string[][] = [];
    await assert.rejects(
      runPromotionInWorktree(
        { version: '1.2.3', mainSHA: MAIN_SHA },
        {
          createWorktree: async () => '/tmp/promote',
          removeWorktree: async () => undefined,
          promotionTargets: () => ['/tmp/promote/examples/minimal/Dockerfile'],
          readFile: () => 'FROM docker.io/cloudflare/sandbox:1.2.2\n',
          writeFile: () => undefined,
          git: async (args) => {
            gitCalls.push(args);
            if (args.join(' ') === 'rev-parse HEAD') return `${MAIN_SHA}\n`;
            return args[0] === 'diff'
              ? 'examples/minimal/Dockerfile\npackage-lock.json\n'
              : '';
          },
          upsertPR: async () =>
            'https://github.com/cloudflare/sandbox-sdk/pull/1'
        }
      ),
      /Unexpected staged promotion path: package-lock\.json/
    );
    assert.deepEqual(
      gitCalls.find((args) => args[0] === 'add'),
      ['add', '--', 'examples/minimal/Dockerfile']
    );
  });

  test('computes no-edits only inside the requested main worktree', async () => {
    const removed: string[] = [];
    const result = await runPromotionInWorktree(
      { version: '1.2.3', mainSHA: MAIN_SHA },
      {
        createWorktree: async (mainSHA) => {
          assert.equal(mainSHA, MAIN_SHA);
          return '/tmp/promote';
        },
        removeWorktree: async (path) => {
          removed.push(path);
        },
        promotionTargets: (root) => {
          assert.equal(root, '/tmp/promote');
          return ['/tmp/promote/examples/minimal/Dockerfile'];
        },
        readFile: () => 'FROM docker.io/cloudflare/sandbox:1.2.3\n',
        writeFile: () => assert.fail('must not write matching references'),
        git: async (args, options) => {
          assert.equal(options.cwd, '/tmp/promote');
          assert.deepEqual(args, ['rev-parse', 'HEAD']);
          return `${MAIN_SHA}\n`;
        },
        upsertPR: async () => assert.fail('must not open a PR')
      }
    );

    assert.deepEqual(result, { status: 'no-edits' });
    assert.deepEqual(removed, ['/tmp/promote']);
  });

  test('commits and opens a PR from the isolated worktree', async () => {
    const gitCalls: string[][] = [];
    const writes = new Map<string, string>();
    const result = await runPromotionInWorktree(
      { version: '1.2.3', mainSHA: MAIN_SHA },
      {
        createWorktree: async () => '/tmp/promote',
        removeWorktree: async () => undefined,
        promotionTargets: () => ['/tmp/promote/examples/minimal/Dockerfile'],
        readFile: () => 'FROM docker.io/cloudflare/sandbox:1.2.2\n',
        writeFile: (path, content) => writes.set(path, content),
        git: async (args) => {
          gitCalls.push(args);
          if (args[0] === 'rev-parse') return `${MAIN_SHA}\n`;
          if (args[0] === 'diff') return 'examples/minimal/Dockerfile\n';
          return '';
        },
        upsertPR: async (version, branch) => {
          assert.equal(version, '1.2.3');
          assert.equal(branch, 'promote/1.2.3');
          return 'https://github.com/cloudflare/sandbox-sdk/pull/1';
        }
      }
    );

    assert.deepEqual(result, {
      status: 'pr-created',
      branch: 'promote/1.2.3'
    });
    assert.equal(
      writes.get('/tmp/promote/examples/minimal/Dockerfile'),
      'FROM docker.io/cloudflare/sandbox:1.2.3\n'
    );
    assert.deepEqual(gitCalls, [
      ['rev-parse', 'HEAD'],
      ['add', '--', 'examples/minimal/Dockerfile'],
      ['diff', '--cached', '--name-only'],
      ['commit', '-m', 'Promote public refs to 1.2.3'],
      ['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/promote/1.2.3']
    ]);
  });

  test('rejects a worktree at a different SHA and always removes it', async () => {
    const removed: string[] = [];
    await assert.rejects(
      runPromotionInWorktree(
        { version: '1.2.3', mainSHA: MAIN_SHA },
        {
          createWorktree: async () => '/tmp/promote',
          removeWorktree: async (path) => {
            removed.push(path);
          },
          promotionTargets: () => assert.fail('must reject before reading'),
          readFile: () => assert.fail('must reject before reading'),
          writeFile: () => assert.fail('must reject before writing'),
          git: async () => 'ffffffffffffffffffffffffffffffffffffffff\n',
          upsertPR: async () => assert.fail('must reject before opening PR')
        }
      ),
      /Promotion worktree HEAD f{40} does not match requested mainSHA/
    );
    assert.deepEqual(removed, ['/tmp/promote']);
  });

  test('rejects a target outside the worktree before reading or writing', async () => {
    await assert.rejects(
      runPromotionInWorktree(
        { version: '1.2.3', mainSHA: MAIN_SHA },
        {
          createWorktree: async () => '/tmp/promote',
          removeWorktree: async () => undefined,
          promotionTargets: () => ['/tmp/package-lock.json'],
          readFile: () => assert.fail('must reject before reading'),
          writeFile: () => assert.fail('must reject before writing'),
          git: async () => `${MAIN_SHA}\n`,
          upsertPR: async () => assert.fail('must reject before opening PR')
        }
      ),
      /Promotion path escapes worktree: \/tmp\/package-lock\.json/
    );
  });
});

function promotionDepsWithContent(content: string) {
  return {
    createWorktree: async () => '/tmp/promote',
    removeWorktree: async () => undefined,
    promotionTargets: () => ['/tmp/promote/examples/minimal/Dockerfile'],
    readFile: () => content,
    writeFile: () => undefined,
    git: async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${MAIN_SHA}\n`;
      if (args[0] === 'diff') return 'examples/minimal/Dockerfile\n';
      return '';
    },
    upsertPR: async () => 'https://github.com/cloudflare/sandbox-sdk/pull/1'
  };
}

describe('assertExactStagedPaths', () => {
  test('rejects a missing expected path', () => {
    assert.throws(
      () => assertExactStagedPaths(['expected'], []),
      /Expected promotion path not staged: expected/
    );
  });
});
