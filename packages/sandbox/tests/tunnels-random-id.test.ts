import { describe, expect, it } from 'vitest';
import { randomId } from '../src/tunnels/random-id';

describe('randomId', () => {
  it('returns 20 lowercase base32 characters by default', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(randomId()).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/);
    }
  });

  it('honours a requested size', () => {
    expect(randomId(8)).toHaveLength(8);
    expect(randomId(32)).toHaveLength(32);
  });

  it('never emits the ambiguous characters i, l, o, or u', () => {
    const sample = Array.from({ length: 500 }, () => randomId()).join('');
    expect(sample).not.toMatch(/[ilou]/);
  });

  it('does not collide across a large batch', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => randomId()));
    expect(ids.size).toBe(10_000);
  });
});
