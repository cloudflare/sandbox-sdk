// Crockford base32 alphabet (lowercase), excluding i, l, o, u to avoid
// visual ambiguity. 32 symbols means each character carries exactly 5 bits
// of entropy drawn uniformly from crypto.getRandomValues, and the alphabet
// is safe to use as a DNS label or URL path segment.
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Generate a URL- and DNS-safe random id. The default 20 characters give
 * ~100 bits of entropy, which keeps collisions negligible at any realistic
 * volume without a uniqueness retry loop. 32 divides 256 evenly, so masking
 * the low 5 bits of each random byte stays uniform.
 */
export function randomId(size = 20): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < size; i += 1) {
    id += ID_ALPHABET[bytes[i] & 31];
  }
  return id;
}
