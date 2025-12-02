import { describe, expect, it } from 'bun:test';
import { isThenable } from '../../src/runtime/executors/shared/thenable';

describe('isThenable', () => {
  it('returns true for Promise', () => {
    expect(isThenable(Promise.resolve(42))).toBe(true);
  });

  it('returns true for custom thenable', () => {
    expect(isThenable({ then: () => {} })).toBe(true);
  });

  it('returns false for non-thenable', () => {
    expect(isThenable(null)).toBe(false);
    expect(isThenable(42)).toBe(false);
    expect(isThenable({ then: 'not a function' })).toBe(false);
  });
});
