const REDACTED = '[REDACTED]';

const ENTROPY_MIN_LENGTH = 8;
const ENTROPY_THRESHOLD = 3.5;

const SENSITIVE_KEY_SUBSTRINGS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'API_KEY',
  'PRIVATE_KEY',
  'PRIVATE',
  'CREDENTIAL',
  'ACCESS_KEY',
  'ACCESS_TOKEN',
  'AUTH',
  'CERT',
  'DATABASE_URL',
  'DSN',
  'CONNECTION_STRING'
];

const SENSITIVE_FLAG_NAMES = [
  'token',
  'secret',
  'key',
  'password',
  'passwd',
  'pass',
  'apikey',
  'api-key',
  'api_key',
  'private-key',
  'private_key',
  'credential',
  'auth',
  'bearer',
  'access-token',
  'access_token',
  'certificate',
  'cert'
];

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  const len = s.length;
  let h = 0;
  for (const count of freq.values()) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function stripShellQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function isHighEntropy(value: string): boolean {
  const inner = stripShellQuotes(value);
  return (
    inner.length >= ENTROPY_MIN_LENGTH &&
    shannonEntropy(inner) >= ENTROPY_THRESHOLD
  );
}

function isSensitiveKeyName(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((sub) => upper.includes(sub));
}

// Matches a shell word: single-quoted, double-quoted, or a non-whitespace/non-semicolon run
const WORD = `(?:'[^']*'|"[^"]*"|[^\\s;]+)`;

// Regex for export VAR=VALUE (handles optional flags like -n, -x)
const EXPORT_RE = new RegExp(
  `\\bexport\\b((?:\\s+-\\S+)*)\\s+([A-Za-z_][A-Za-z0-9_]*)=(${WORD})?`,
  'g'
);

// Regex for bare VAR=VALUE at string start or after whitespace
const ASSIGNMENT_RE = new RegExp(
  `(^|\\s)([A-Za-z_][A-Za-z0-9_]*)=(${WORD})`,
  'g'
);

// Regex for sensitive CLI flags: --token VALUE, --token=VALUE, etc.
const SENSITIVE_FLAG_RE = new RegExp(
  `(--(?:${SENSITIVE_FLAG_NAMES.map((n) => n.replace(/-/g, '[-_]')).join('|')}))(?:=(${WORD})|([ \\t]+)(${WORD}))`,
  'gi'
);

/**
 * Sanitize a shell command string for safe log output.
 *
 * Partially redacts values that are likely to be secrets based on:
 * - Key/variable name matching known sensitive patterns
 * - Shannon entropy heuristic for high-entropy values in export context
 * - Sensitive CLI flag names (--token, --password, etc.)
 *
 * Only intended for log strings. Does not affect the command itself,
 * HTTP payloads, return values, or any execution behavior.
 *
 * Set SANDBOX_LOG_REDACTION=disabled (or '0' / 'false') to disable redaction.
 */
export function sanitizeCommandForLog(command: string): string {
  if (!command) return command;

  const flag = process.env.SANDBOX_LOG_REDACTION;
  if (flag === 'disabled' || flag === '0' || flag === 'false') return command;

  let out = command;

  // Rule 1: export [flags] VAR=VALUE
  // Redact value when key name is sensitive or value has high entropy
  EXPORT_RE.lastIndex = 0;
  out = out.replace(
    EXPORT_RE,
    (_m, flags: string, key: string, value?: string) => {
      if (!value) return _m;
      if (isSensitiveKeyName(key) || isHighEntropy(value)) {
        return `export${flags} ${key}=${REDACTED}`;
      }
      return _m;
    }
  );

  // Rule 2: Bare VAR=VALUE at string start or after whitespace (inline env prefix).
  // Only redact when key name is explicitly sensitive to avoid false positives
  // in non-shell contexts (e.g. grep patterns, config strings).
  ASSIGNMENT_RE.lastIndex = 0;
  out = out.replace(
    ASSIGNMENT_RE,
    (_m, space: string, key: string, value: string) => {
      if (isSensitiveKeyName(key)) {
        return `${space}${key}=${REDACTED}`;
      }
      return _m;
    }
  );

  // Rule 3: --sensitive-flag=value or --sensitive-flag value
  SENSITIVE_FLAG_RE.lastIndex = 0;
  out = out.replace(
    SENSITIVE_FLAG_RE,
    (_m, flag: string, eqVal?: string, space?: string, _spaceVal?: string) => {
      if (eqVal !== undefined) return `${flag}=${REDACTED}`;
      return `${flag}${space}${REDACTED}`;
    }
  );

  return out;
}
