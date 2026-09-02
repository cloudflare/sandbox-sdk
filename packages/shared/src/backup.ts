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

type ParsedBackupExcludePattern =
  | { success: true; normalized: string; recursive: boolean }
  | { success: false; error: string };

function matchesEveryNonemptyPathComponent(pattern: string): boolean {
  if (pattern.includes('/')) return false;

  const requiredCharacters = pattern.replace(/\*/g, '');
  return (
    requiredCharacters === '' ||
    (requiredCharacters === '?' && pattern.includes('*'))
  );
}

function parseBackupExcludePattern(
  pattern: string
): ParsedBackupExcludePattern {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: exclude files are line-delimited
  if (/[\u0000-\u001f\u007f]/.test(pattern)) {
    return {
      success: false,
      error: 'patterns must not contain control characters'
    };
  }
  if (pattern.trim() !== pattern) {
    return {
      success: false,
      error: 'patterns must not have leading or trailing whitespace'
    };
  }
  if (
    pattern.startsWith('/') ||
    pattern.startsWith('./') ||
    pattern.startsWith('../')
  ) {
    return {
      success: false,
      error: "patterns must not start with '/', './', or '../'"
    };
  }
  if (pattern.startsWith('... ')) {
    return {
      success: false,
      error: "patterns must not start with mksquashfs sticky syntax ('... ')"
    };
  }

  const pathWithoutTrailingSlash = pattern.endsWith('/')
    ? pattern.slice(0, -1)
    : pattern;
  if (
    pathWithoutTrailingSlash
      .split('/')
      .some(
        (component) =>
          component === '' || component === '.' || component === '..'
      )
  ) {
    return {
      success: false,
      error: "patterns must not contain empty, '.', or '..' path components"
    };
  }

  let normalized = pathWithoutTrailingSlash;
  let leadingGlobstarConsumed = false;
  while (normalized.startsWith('**/')) {
    normalized = normalized.slice(3);
    leadingGlobstarConsumed = true;
  }

  let trailingGlobstarConsumed = false;
  if (normalized.endsWith('/**')) {
    normalized = normalized.slice(0, -3);
    trailingGlobstarConsumed = true;
  }

  if (!normalized || normalized === '**') {
    return {
      success: false,
      error: 'patterns must not be empty or consist only of recursive globstars'
    };
  }
  // Backup path components are non-empty. Stars alone match every component,
  // while one `?` supplies the required character and a star absorbs the rest.
  if (matchesEveryNonemptyPathComponent(normalized)) {
    return {
      success: false,
      error: 'patterns must not match the entire backup'
    };
  }
  if (
    normalized.split('/').includes('**') ||
    (leadingGlobstarConsumed && normalized.includes('/'))
  ) {
    return {
      success: false,
      error:
        'recursive globstars with multiple path components are not supported; use a root-relative multi-component pattern or a single-component pattern for recursive exclusion'
    };
  }

  return {
    success: true,
    normalized,
    recursive:
      leadingGlobstarConsumed ||
      (!trailingGlobstarConsumed && !normalized.includes('/'))
  };
}

export function getBackupExcludePatternError(
  pattern: string
): string | undefined {
  const parsed = parseBackupExcludePattern(pattern);
  return parsed.success ? undefined : parsed.error;
}

export function expandBackupExcludePattern(pattern: string): string[] {
  const parsed = parseBackupExcludePattern(pattern);
  if (!parsed.success) {
    throw new TypeError(`Invalid backup exclude pattern: ${parsed.error}`);
  }

  return parsed.recursive
    ? [parsed.normalized, `... ${parsed.normalized}`]
    : [parsed.normalized];
}
