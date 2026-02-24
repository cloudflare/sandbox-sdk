import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GitManager } from '@sandbox-container/managers/git-manager';

const manager = new GitManager();

type FixtureExpectation = {
  currentBranch: string;
  ahead: number;
  behind: number;
  branchPublished: boolean;
  fileStatus: Array<{
    path: string;
    indexStatus: string;
    workingTreeStatus: string;
  }>;
};

const cases: Array<{ file: string; expected: FixtureExpectation }> = [
  {
    file: 'au-ua-dd-conflicts.txt',
    expected: {
      currentBranch: 'feature/conflicts',
      ahead: 1,
      behind: 0,
      branchPublished: true,
      fileStatus: [
        {
          path: 'src/added-by-us.ts',
          indexStatus: 'A',
          workingTreeStatus: 'U'
        },
        {
          path: 'src/added-by-them.ts',
          indexStatus: 'U',
          workingTreeStatus: 'A'
        },
        {
          path: 'src/deleted-both.ts',
          indexStatus: 'D',
          workingTreeStatus: 'D'
        }
      ]
    }
  },
  {
    file: 'quoted-space-paths.txt',
    expected: {
      currentBranch: 'main',
      ahead: 0,
      behind: 0,
      branchPublished: true,
      fileStatus: [
        { path: 'docs/My File.md', indexStatus: '?', workingTreeStatus: '?' },
        { path: 'src/with space.ts', indexStatus: ' ', workingTreeStatus: 'M' },
        { path: 'src/new name.ts', indexStatus: 'R', workingTreeStatus: ' ' },
        { path: 'src/base copy.ts', indexStatus: 'C', workingTreeStatus: ' ' }
      ]
    }
  },
  {
    file: 'upstream-gone.txt',
    expected: {
      currentBranch: 'feature/old',
      ahead: 0,
      behind: 0,
      branchPublished: false,
      fileStatus: [
        { path: 'src/legacy.ts', indexStatus: 'M', workingTreeStatus: ' ' }
      ]
    }
  },
  {
    file: 'submodule-like-status.txt',
    expected: {
      currentBranch: 'main',
      ahead: 1,
      behind: 0,
      branchPublished: true,
      fileStatus: [
        {
          path: 'deps/some-submodule',
          indexStatus: ' ',
          workingTreeStatus: 'M'
        },
        {
          path: 'libs/another-submodule',
          indexStatus: 'M',
          workingTreeStatus: ' '
        },
        {
          path: 'deps/new-submodule',
          indexStatus: '?',
          workingTreeStatus: '?'
        }
      ]
    }
  }
];

describe('GitManager parseStatus fixture coverage', () => {
  for (const testCase of cases) {
    it(`parses ${testCase.file}`, () => {
      const output = readFileSync(
        new URL(`../fixtures/git-status/${testCase.file}`, import.meta.url),
        'utf8'
      );

      const result = manager.parseStatus(output);
      expect(result).toEqual(testCase.expected);
    });
  }
});
