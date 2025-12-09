/**
 * API key generation utilities
 */
import { createHash, randomBytes } from 'node:crypto';

const API_KEY_PREFIX = 'sk_sandbox_';

export function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `${API_KEY_PREFIX}${bytes.toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function isValidApiKey(key: string): boolean {
  return (
    key.startsWith(API_KEY_PREFIX) && key.length === API_KEY_PREFIX.length + 48
  );
}
