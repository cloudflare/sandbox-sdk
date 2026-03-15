import { describe, expect, it } from 'vitest';
import { calculateEntropy, isHighEntropy } from '../src/entropy';

describe('calculateEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(calculateEntropy('')).toBe(0);
  });

  it('returns 0 for single repeated character', () => {
    expect(calculateEntropy('aaaaaaa')).toBe(0);
  });

  it('returns 1 for two equally distributed characters', () => {
    expect(calculateEntropy('ab')).toBeCloseTo(1.0, 5);
  });

  it('returns high entropy for API key-like strings', () => {
    const apiKey = 'sk-ant-api03-xK9m2nP7qR4sT6uV8wX0yZ';
    expect(calculateEntropy(apiKey)).toBeGreaterThan(4.0);
  });

  it('returns low entropy for simple config values', () => {
    expect(calculateEntropy('production')).toBeLessThan(4.0);
    expect(calculateEntropy('true')).toBeLessThan(4.0);
  });
});

describe('isHighEntropy', () => {
  it('returns false for short strings regardless of entropy', () => {
    expect(isHighEntropy('ab12!@')).toBe(false);
  });

  it('returns true for API key-like strings', () => {
    expect(isHighEntropy('sk-ant-api03-xK9m2nP7qR4sT6uV8wX0yZ')).toBe(true);
    expect(isHighEntropy('ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P')).toBe(true);
  });

  it('returns false for common env var values', () => {
    expect(isHighEntropy('production')).toBe(false);
    expect(isHighEntropy('localhost')).toBe(false);
    expect(isHighEntropy('/usr/local/bin')).toBe(false);
    expect(isHighEntropy('https://example.com')).toBe(false);
  });

  it('respects custom threshold', () => {
    const value = 'moderateEntropy12';
    const entropy = calculateEntropy(value);
    expect(isHighEntropy(value, entropy - 0.1)).toBe(true);
    expect(isHighEntropy(value, entropy + 0.1)).toBe(false);
  });
});
