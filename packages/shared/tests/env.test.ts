import { describe, expect, it } from 'vitest';
import { filterEnvVars, getEnvString, partitionEnvVars } from '../src/env';

describe('filterEnvVars', () => {
  it('passes through valid string values', () => {
    const input = { KEY: 'value', ANOTHER: 'test' };
    expect(filterEnvVars(input)).toEqual(input);
  });

  it('skips undefined values', () => {
    const input = { KEY: 'value', MISSING: undefined };
    expect(filterEnvVars(input)).toEqual({ KEY: 'value' });
  });

  it('skips null values', () => {
    const input = { KEY: 'value', MISSING: null } as Record<
      string,
      string | null
    >;
    expect(filterEnvVars(input)).toEqual({ KEY: 'value' });
  });

  it('returns empty object when all values are undefined', () => {
    const input = { A: undefined, B: undefined };
    expect(filterEnvVars(input)).toEqual({});
  });

  it('accepts empty string values', () => {
    const input = { EMPTY: '' };
    expect(filterEnvVars(input)).toEqual({ EMPTY: '' });
  });

  it('handles process.env spreading pattern', () => {
    const input = {
      PATH: '/usr/bin',
      UNSET_VAR: undefined,
      HOME: '/home/user'
    };
    expect(filterEnvVars(input)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user'
    });
  });

  it('handles empty input object', () => {
    expect(filterEnvVars({})).toEqual({});
  });

  it('preserves special characters in values', () => {
    const input = { SPECIAL: "value with 'quotes' and $pecial chars" };
    expect(filterEnvVars(input)).toEqual(input);
  });
});

describe('getEnvString', () => {
  it('returns string values', () => {
    const env = { KEY: 'value' };
    expect(getEnvString(env, 'KEY')).toBe('value');
  });

  it('returns undefined for missing keys', () => {
    const env = { KEY: 'value' };
    expect(getEnvString(env, 'MISSING')).toBeUndefined();
  });

  it('returns undefined for non-string values', () => {
    const env = { NUM: 123, BOOL: true } as Record<string, unknown>;
    expect(getEnvString(env, 'NUM')).toBeUndefined();
    expect(getEnvString(env, 'BOOL')).toBeUndefined();
  });
});

describe('partitionEnvVars', () => {
  it('partitions string values to toSet', () => {
    const input = { KEY: 'value', ANOTHER: 'test' };
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({ KEY: 'value', ANOTHER: 'test' });
    expect(result.toUnset).toEqual([]);
  });

  it('partitions undefined values to toUnset', () => {
    const input = { KEY: 'value', REMOVE: undefined };
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({ KEY: 'value' });
    expect(result.toUnset).toEqual(['REMOVE']);
  });

  it('partitions null values to toUnset', () => {
    const input = { KEY: 'value', REMOVE: null } as Record<
      string,
      string | null
    >;
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({ KEY: 'value' });
    expect(result.toUnset).toEqual(['REMOVE']);
  });

  it('handles mixed set and unset values', () => {
    const input = {
      KEEP: 'keep-value',
      REMOVE1: undefined,
      ALSO_KEEP: 'another',
      REMOVE2: null
    } as Record<string, string | undefined | null>;
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({ KEEP: 'keep-value', ALSO_KEEP: 'another' });
    expect(result.toUnset).toContain('REMOVE1');
    expect(result.toUnset).toContain('REMOVE2');
    expect(result.toUnset).toHaveLength(2);
  });

  it('handles all undefined input', () => {
    const input = { A: undefined, B: undefined };
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({});
    expect(result.toUnset).toEqual(['A', 'B']);
  });

  it('handles empty input', () => {
    const result = partitionEnvVars({});
    expect(result.toSet).toEqual({});
    expect(result.toUnset).toEqual([]);
  });

  it('preserves empty string in toSet', () => {
    const input = { EMPTY: '', REMOVE: undefined };
    const result = partitionEnvVars(input);
    expect(result.toSet).toEqual({ EMPTY: '' });
    expect(result.toUnset).toEqual(['REMOVE']);
  });
});
