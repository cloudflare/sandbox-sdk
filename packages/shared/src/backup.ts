/**
 * Absolute directory prefixes supported by backup and restore operations.
 */
export const BACKUP_ALLOWED_PREFIXES = [
  '/workspace',
  '/home',
  '/tmp',
  '/var/tmp',
  '/app'
] as const;

export function normalizeBackupExcludePattern(pattern: string): string | null {
  let normalized = pattern;

  while (normalized.startsWith('**/')) {
    normalized = normalized.slice(3);
  }

  while (normalized.includes('/**/')) {
    normalized = normalized.replace(/\/\*\*\//g, '/');
  }

  if (normalized.endsWith('/**')) {
    normalized = normalized.slice(0, -3);
  }

  if (!normalized || normalized === '**') {
    return null;
  }

  return normalized;
}
