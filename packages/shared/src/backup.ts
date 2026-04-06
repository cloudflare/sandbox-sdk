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
