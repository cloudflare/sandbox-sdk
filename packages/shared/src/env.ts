/**
 * Safely extract a string value from an environment object
 *
 * @param env - Environment object with dynamic keys
 * @param key - The environment variable key to access
 * @returns The string value if present and is a string, undefined otherwise
 */
export function getEnvString(
  env: Record<string, unknown>,
  key: string
): string | undefined {
  const value = env?.[key];
  return typeof value === 'string' ? value : undefined;
}
