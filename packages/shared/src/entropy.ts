/**
 * Shannon entropy utilities for detecting high-entropy strings (API keys, tokens, etc.)
 */

/**
 * Calculate Shannon entropy of a string in bits per character.
 */
export function calculateEntropy(value: string): number {
  if (value.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Returns true if the string has high Shannon entropy, suggesting it may be
 * a secret (API key, token, password, etc.).
 *
 * Default threshold of 4.0 bits/char catches most API keys and tokens
 * while allowing common config values like URLs and paths through.
 */
export function isHighEntropy(value: string, threshold: number = 4.0): boolean {
  // Short values (< 8 chars) are unlikely to be secrets
  if (value.length < 8) return false;
  return calculateEntropy(value) > threshold;
}
