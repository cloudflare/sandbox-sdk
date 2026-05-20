/**
 * Security utilities for URL construction and input validation
 *
 * This module contains critical security functions to prevent:
 * - URL injection attacks
 * - SSRF (Server-Side Request Forgery) attacks
 * - DNS rebinding attacks
 * - Host header injection
 * - Open redirect vulnerabilities
 */

export class SandboxSecurityError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'SandboxSecurityError';
  }
}

/**
 * Validates port numbers for sandbox services.
 *
 * Rules:
 * - Range: 1024-65535 (privileged ports require root, which containers don't have)
 * - Reserved: 3000 (sandbox control plane)
 */
export function validatePort(port: number): boolean {
  // Must be a valid integer
  if (!Number.isInteger(port)) {
    return false;
  }

  // Only allow non-system ports (1024-65535)
  if (port < 1024 || port > 65535) {
    return false;
  }

  const reservedPorts = [3000];

  if (reservedPorts.includes(port)) {
    return false;
  }

  return true;
}

/**
 * Sanitizes and validates sandbox IDs for DNS compliance and security
 * Only enforces critical requirements - allows maximum developer flexibility
 */
export function sanitizeSandboxId(id: string): string {
  // Basic validation: not empty, reasonable length limit (DNS subdomain limit is 63 chars)
  if (!id || id.length > 63) {
    throw new SandboxSecurityError(
      'Sandbox ID must be 1-63 characters long.',
      'INVALID_SANDBOX_ID_LENGTH'
    );
  }

  // DNS compliance: cannot start or end with hyphens (RFC requirement)
  if (id.startsWith('-') || id.endsWith('-')) {
    throw new SandboxSecurityError(
      'Sandbox ID cannot start or end with hyphens (DNS requirement).',
      'INVALID_SANDBOX_ID_HYPHENS'
    );
  }

  // Prevent reserved names that cause technical conflicts
  const reservedNames = [
    'www',
    'api',
    'admin',
    'root',
    'system',
    'cloudflare',
    'workers'
  ];

  const lowerCaseId = id.toLowerCase();
  if (reservedNames.includes(lowerCaseId)) {
    throw new SandboxSecurityError(
      `Reserved sandbox ID '${id}' is not allowed.`,
      'RESERVED_SANDBOX_ID'
    );
  }

  return id;
}

/**
 * Validates language for code interpreter
 * Only allows supported languages
 */
export function validateLanguage(language: string | undefined): void {
  if (!language) {
    return; // undefined is valid, will default to python
  }

  const supportedLanguages = [
    'python',
    'python3',
    'javascript',
    'js',
    'node',
    'typescript',
    'ts'
  ];
  const normalized = language.toLowerCase();

  if (!supportedLanguages.includes(normalized)) {
    throw new SandboxSecurityError(
      `Unsupported language '${language}'. Supported languages: python, javascript, typescript`,
      'INVALID_LANGUAGE'
    );
  }
}

/**
 * Validates a single DNS label for use as a Cloudflare Tunnel hostname.
 *
 * Used by `sandbox.tunnels.get(port, { name })` to reject obviously-bad
 * input client-side before any network call. Whether the chosen label is
 * actually available under the configured zone is left to the Cloudflare
 * API (returned as a typed error).
 *
 * Rules:
 * - 1–63 characters
 * - Lowercase letters, digits, and internal hyphens only
 * - No leading or trailing hyphen
 * - No dots — multi-label hostnames need a delegated subdomain zone or
 *   Advanced Certificate Manager, which are out of scope for this
 *   feature. Universal SSL only covers `<label>.<zone>`.
 *
 * Throws `SandboxSecurityError` on any violation. Designed to be called
 * before any other tunnel work so callers see a fast, deterministic
 * failure.
 */
const TUNNEL_NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function validateTunnelName(name: string): void {
  if (typeof name !== 'string') {
    throw new SandboxSecurityError(
      `Tunnel name must be a string. Received: ${typeof name}`,
      'INVALID_TUNNEL_NAME'
    );
  }
  if (name.length === 0 || name.length > 63) {
    throw new SandboxSecurityError(
      `Tunnel name '${name}' must be 1–63 characters long.`,
      'INVALID_TUNNEL_NAME_LENGTH'
    );
  }
  if (!TUNNEL_NAME_REGEX.test(name)) {
    throw new SandboxSecurityError(
      `Tunnel name '${name}' is not a valid DNS label. Use lowercase ` +
        'letters, digits, and internal hyphens only (no dots, no ' +
        'leading/trailing hyphens).',
      'INVALID_TUNNEL_NAME_FORMAT'
    );
  }
}
