/**
 * Log-only sanitization helpers
 *
 * These functions redact sensitive values for logging output.
 * They MUST NOT be used to mutate command strings before execution.
 */

/**
 * Sensitive query parameter names to redact from URLs.
 * Anchored to query string context ([?&]) to avoid matching path segments.
 * Value matching stops at & and common URL/command delimiters.
 */
const SENSITIVE_PARAMS =
  /([?&])(X-Amz-Credential|X-Amz-Signature|X-Amz-Security-Token|token|secret|password)=[^&\s"'`<>]*/gi;

/**
 * Redact credentials from URLs for secure logging
 *
 * Replaces any credentials (username:password, tokens, etc.) embedded
 * in URLs with ****** to prevent sensitive data exposure in logs.
 * Works with URLs embedded in text.
 *
 * @param text - String that may contain URLs with credentials
 * @returns String with credentials redacted from any URLs
 */
export function redactCredentials(text: string): string {
  // Scan for http(s):// URLs and redact any credentials found
  let result = text;
  let pos = 0;

  while (pos < result.length) {
    const httpPos = result.indexOf('http://', pos);
    const httpsPos = result.indexOf('https://', pos);

    let protocolPos = -1;
    let protocolLen = 0;

    if (httpPos === -1 && httpsPos === -1) break;
    if (httpPos !== -1 && (httpsPos === -1 || httpPos < httpsPos)) {
      protocolPos = httpPos;
      protocolLen = 7; // 'http://'.length
    } else {
      protocolPos = httpsPos;
      protocolLen = 8; // 'https://'.length
    }

    // Look for @ after the protocol
    const searchStart = protocolPos + protocolLen;
    const atPos = result.indexOf('@', searchStart);

    // Find where the URL ends (whitespace, quotes, or structural delimiters)
    let urlEnd = searchStart;
    while (urlEnd < result.length) {
      const char = result[urlEnd];
      if (/[\s"'`<>,;{}[\]]/.test(char)) break;
      urlEnd++;
    }

    if (atPos !== -1 && atPos < urlEnd) {
      result = `${result.substring(0, searchStart)}******${result.substring(atPos)}`;
      pos = searchStart + 6; // Move past '******'
    } else {
      pos = protocolPos + protocolLen;
    }
  }

  return result;
}

/**
 * Redact sensitive query parameters from URLs
 *
 * Strips X-Amz-Credential, X-Amz-Signature, X-Amz-Security-Token,
 * token, secret, and password query params from URLs. Returns
 * non-URL strings unchanged.
 *
 * @param input - String that may contain URLs with sensitive params
 * @returns String with sensitive params replaced by REDACTED
 */
export function redactSensitiveParams(input: string): string {
  if (!input.includes('?') || !input.includes('=')) return input;
  return input.replace(SENSITIVE_PARAMS, '$1$2=REDACTED');
}

/**
 * Redact sensitive data from a command string for logging
 *
 * Composes redactCredentials (URL credentials) and redactSensitiveParams
 * (presigned URL query params). For log values only — never mutate
 * command strings before execution.
 *
 * @param command - Command string to sanitize for logging
 * @returns Sanitized command string
 */
export function redactCommand(command: string): string {
  return redactSensitiveParams(redactCredentials(command));
}

/**
 * Truncate a string for log output with a truncation indicator
 *
 * @param value - String to potentially truncate
 * @param maxLen - Maximum length before truncation (default 120)
 * @returns Object with truncated value and boolean flag
 */
export function truncateForLog(
  value: string,
  maxLen = 120
): { value: string; truncated: boolean } {
  if (value.length <= maxLen) {
    return { value, truncated: false };
  }
  const cutoff = Math.max(0, maxLen - 3);
  return { value: `${value.substring(0, cutoff)}...`, truncated: true };
}
