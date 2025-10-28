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

export class SecurityError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Validates port numbers for sandbox services
 * Only allows non-system ports to prevent conflicts and security issues
 * @param port The port number to validate
 * @param controlPlanePort The configured control plane port (dynamic)
 */
export function validatePort(port: number, controlPlanePort: number = 3000): boolean {
  // Must be a valid integer
  if (!Number.isInteger(port)) {
    return false;
  }

  // Only allow non-system ports (1024-65535)
  if (port < 1024 || port > 65535) {
    return false;
  }

  // Exclude ports reserved by our system (dynamic based on actual control plane port)
  const reservedPorts = [
    controlPlanePort,  // Dynamic control plane port
    8787,              // Common wrangler dev port
  ];

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
    throw new SecurityError(
      'Sandbox ID must be 1-63 characters long.',
      'INVALID_SANDBOX_ID_LENGTH'
    );
  }

  // DNS compliance: cannot start or end with hyphens (RFC requirement)
  if (id.startsWith('-') || id.endsWith('-')) {
    throw new SecurityError(
      'Sandbox ID cannot start or end with hyphens (DNS requirement).',
      'INVALID_SANDBOX_ID_HYPHENS'
    );
  }

  // Prevent reserved names that cause technical conflicts
  const reservedNames = [
    'www', 'api', 'admin', 'root', 'system',
    'cloudflare', 'workers'
  ];

  const lowerCaseId = id.toLowerCase();
  if (reservedNames.includes(lowerCaseId)) {
    throw new SecurityError(
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

  const supportedLanguages = ['python', 'python3', 'javascript', 'js', 'node', 'typescript', 'ts'];
  const normalized = language.toLowerCase();

  if (!supportedLanguages.includes(normalized)) {
    throw new SecurityError(
      `Unsupported language '${language}'. Supported languages: python, javascript, typescript`,
      'INVALID_LANGUAGE'
    );
  }
}
