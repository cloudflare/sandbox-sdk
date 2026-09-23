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
  | { success: false; reason: string };

type BackupExcludeMarkers = {
  canonicalPath: string;
  remainder: string;
  leadingGlobstarConsumed: boolean;
  trailingGlobstarConsumed: boolean;
};

function stripBackupExcludeMarkers(pattern: string): BackupExcludeMarkers {
  const canonicalPath = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  let remainder = canonicalPath;
  let leadingGlobstarConsumed = false;
  while (remainder.startsWith('**/')) {
    remainder = remainder.slice(3);
    leadingGlobstarConsumed = true;
  }
  let trailingGlobstarConsumed = false;
  if (remainder.endsWith('/**')) {
    remainder = remainder.slice(0, -3);
    trailingGlobstarConsumed = true;
  }
  return {
    canonicalPath,
    remainder,
    leadingGlobstarConsumed,
    trailingGlobstarConsumed
  };
}

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
      reason: 'patterns must not contain control characters'
    };
  }
  if (pattern.trim() !== pattern) {
    return {
      success: false,
      reason: 'patterns must not have leading or trailing whitespace'
    };
  }
  if (
    pattern.startsWith('/') ||
    pattern.startsWith('./') ||
    pattern.startsWith('../')
  ) {
    return {
      success: false,
      reason: "patterns must not start with '/', './', or '../'"
    };
  }
  if (pattern.startsWith('... ')) {
    return {
      success: false,
      reason: "patterns must not start with mksquashfs sticky syntax ('... ')"
    };
  }

  const markers = stripBackupExcludeMarkers(pattern);
  if (
    markers.canonicalPath
      .split('/')
      .some(
        (component) =>
          component === '' || component === '.' || component === '..'
      )
  ) {
    return {
      success: false,
      reason: "patterns must not contain empty, '.', or '..' path components"
    };
  }
  if (!markers.remainder || markers.remainder === '**') {
    return {
      success: false,
      reason:
        'patterns must not be empty or consist only of recursive globstars'
    };
  }
  // Backup path components are non-empty. Stars alone match every component,
  // while one `?` supplies the required character and a star absorbs the rest.
  if (matchesEveryNonemptyPathComponent(markers.remainder)) {
    return {
      success: false,
      reason: 'patterns must not match the entire backup'
    };
  }
  if (
    markers.remainder.split('/').includes('**') ||
    (markers.leadingGlobstarConsumed && markers.remainder.includes('/'))
  ) {
    return {
      success: false,
      reason:
        'recursive globstars with multiple path components are not supported; use a root-relative multi-component pattern or a single-component pattern for recursive exclusion'
    };
  }

  return {
    success: true,
    normalized: markers.remainder,
    recursive:
      markers.leadingGlobstarConsumed ||
      (!markers.trailingGlobstarConsumed && !markers.remainder.includes('/'))
  };
}

export function getBackupExcludePatternError(
  pattern: string
): string | undefined {
  const parsed = parseBackupExcludePattern(pattern);
  return parsed.success ? undefined : parsed.reason;
}

export function expandBackupExcludePattern(pattern: string): string[] {
  const parsed = parseBackupExcludePattern(pattern);
  if (!parsed.success) {
    throw new TypeError(parsed.reason);
  }
  return parsed.recursive
    ? [parsed.normalized, `... ${parsed.normalized}`]
    : [parsed.normalized];
}
