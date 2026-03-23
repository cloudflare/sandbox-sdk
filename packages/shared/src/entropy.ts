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
 * while allowing common config values like URLs and paths through. Values
 * shorter than 8 characters are treated as non-secrets here, so short secrets
 * require explicit `redact: true` to be covered.
 */
export function isHighEntropy(value: string, threshold: number = 4.0): boolean {
  // Short values (< 8 chars) are unlikely to be secrets
  if (value.length < 8) return false;
  return calculateEntropy(value) > threshold;
}

/**
 *  'forced' = caller explicitly requested redaction (logged as [REDACTED])
 *  'auto'   = entropy-detected secret (logged as [AUTO-REDACTED])
 */
export type RedactionMode = 'forced' | 'auto';

/**
 * Determine the effective redaction mode for a value.
 *  - true  → always redact, regardless of content
 *  - undefined (default) → redact only when Shannon entropy suggests a secret
 *  - false → skip redaction entirely, even auto-detection
 *
 * When auto-detection is used, values shorter than 8 characters are not
 * redacted unless the caller forces redaction.
 */
export function shouldRedact(
  redact: boolean | undefined,
  value: string
): RedactionMode | undefined {
  if (redact === false) return undefined;
  if (redact === true) return 'forced';
  return isHighEntropy(value) ? 'auto' : undefined;
}

/**
 * Map a RedactionMode to its human-readable log label.
 * Returns undefined when no redaction is active.
 */
export function getRedactionLabel(
  mode: RedactionMode | undefined
): string | undefined {
  if (mode === 'forced') return '[REDACTED]';
  if (mode === 'auto') return '[AUTO-REDACTED]';
  return undefined;
}
