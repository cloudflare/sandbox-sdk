import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computePromotionEdits } from './promotion-plan.ts';

describe('computePromotionEdits', () => {
  test('rewrites docker.io and bare refs across files, preserving suffixes', () => {
    const edits = computePromotionEdits(
      [
        {
          path: 'a/Dockerfile',
          content: 'FROM docker.io/cloudflare/sandbox:0.12.4\n'
        },
        {
          path: 'b/Dockerfile',
          content: 'FROM docker.io/cloudflare/sandbox:0.12.4-musl\n'
        },
        {
          path: 'DOCKER_README.md',
          content: 'FROM cloudflare/sandbox:0.12.4-python\n'
        }
      ],
      '0.12.5'
    );

    assert.deepEqual(edits, [
      {
        path: 'a/Dockerfile',
        content: 'FROM docker.io/cloudflare/sandbox:0.12.5\n'
      },
      {
        path: 'b/Dockerfile',
        content: 'FROM docker.io/cloudflare/sandbox:0.12.5-musl\n'
      },
      {
        path: 'DOCKER_README.md',
        content: 'FROM cloudflare/sandbox:0.12.5-python\n'
      }
    ]);
  });

  test('returns no edits when everything is already at the target version', () => {
    const edits = computePromotionEdits(
      [
        {
          path: 'a/Dockerfile',
          content: 'FROM docker.io/cloudflare/sandbox:0.12.5\n'
        }
      ],
      '0.12.5'
    );
    assert.deepEqual(edits, []);
  });

  test('ignores sandbox-test image references', () => {
    const edits = computePromotionEdits(
      [
        {
          path: 'x/Dockerfile',
          content: 'FROM cloudflare/sandbox-test:0.12.4\n'
        }
      ],
      '0.12.5'
    );
    assert.deepEqual(edits, []);
  });

  test('rejects mixed source versions across files', () => {
    assert.throws(
      () =>
        computePromotionEdits(
          [
            {
              path: 'a/Dockerfile',
              content: 'FROM docker.io/cloudflare/sandbox:0.12.3\n'
            },
            {
              path: 'b/Dockerfile',
              content: 'FROM docker.io/cloudflare/sandbox:0.12.4\n'
            }
          ],
          '0.12.5'
        ),
      /Mixed sandbox image versions: 0\.12\.3, 0\.12\.4/
    );
  });

  test('rejects a malformed sandbox image tag', () => {
    assert.throws(
      () =>
        computePromotionEdits(
          [
            {
              path: 'a/Dockerfile',
              content: 'FROM cloudflare/sandbox:latest\n'
            }
          ],
          '0.12.5'
        ),
      /Malformed sandbox image reference: cloudflare\/sandbox:latest/
    );
  });

  test('rejects a malformed target version', () => {
    assert.throws(
      () => computePromotionEdits([], 'v0.12'),
      /Malformed target version: v0\.12/
    );
  });
});
