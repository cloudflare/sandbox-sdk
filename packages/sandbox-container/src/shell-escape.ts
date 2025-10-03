/**
 * Secure shell command utilities to prevent injection attacks
 */

/**
 * Escapes a string for safe use in shell commands.
 * This follows POSIX shell escaping rules to prevent command injection.
 * 
 * @param str - The string to escape
 * @returns The escaped string safe for shell use
 */
export function escapeShellArg(str: string): string {
  // If string is empty, return empty quotes
  if (str === '') {
    return "''";
  }

  // Check if string contains any characters that need escaping
  // Safe characters: alphanumeric, dash, underscore, dot, slash
  if (/^[a-zA-Z0-9._\-/]+$/.test(str)) {
    return str;
  }

  // For strings with special characters, use single quotes and escape single quotes
  // Single quotes preserve all characters literally except the single quote itself
  // To include a single quote, we end the quoted string, add an escaped quote, and start a new quoted string
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Escapes a file path for safe use in shell commands.
 * 
 * @param path - The file path to escape
 * @returns The escaped path safe for shell use
 */
export function escapeShellPath(path: string): string {
  // Normalize path to prevent issues with multiple slashes
  const normalizedPath = path.replace(/\/+/g, '/');
  
  // Apply standard shell escaping
  return escapeShellArg(normalizedPath);
}