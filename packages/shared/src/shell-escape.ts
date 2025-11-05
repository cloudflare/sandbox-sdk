/**
 * Escapes a string for safe use in shell commands using POSIX single-quote escaping.
 * Prevents command injection by wrapping the string in single quotes and escaping
 * any single quotes within the string.
 */
export function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
