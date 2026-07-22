import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionSummary, type Decision } from './release-decisions.ts';

describe('decision summaries', () => {
  test('lists missing, matching, and conflict decisions deterministically', () => {
    const decisions: Record<string, Decision<string, string>> = {
      npm: { state: 'missing' },
      git: { state: 'matching', observed: 'abc' },
      docker: { state: 'conflict', conflict: 'wrong digest' }
    };

    assert.deepEqual(createDecisionSummary(decisions), {
      missing: ['npm'],
      matching: ['git'],
      conflicts: ['docker: wrong digest']
    });
  });
});
