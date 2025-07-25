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

  // Exclude ports reserved by our system
  const reservedPorts = [
    3000, // Control plane port
    8787, // Common wrangler dev port
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
 * Logs security events for monitoring
 */
export function logSecurityEvent(
  event: string,
  details: Record<string, any>,
  severity: 'low' | 'medium' | 'high' | 'critical' = 'medium'
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event,
    severity,
    ...details
  };

  switch (severity) {
    case 'critical':
    case 'high':
      console.error(`[SECURITY:${severity.toUpperCase()}] ${event}:`, JSON.stringify(logEntry));
      break;
    case 'medium':
      console.warn(`[SECURITY:${severity.toUpperCase()}] ${event}:`, JSON.stringify(logEntry));
      break;
    case 'low':
      console.info(`[SECURITY:${severity.toUpperCase()}] ${event}:`, JSON.stringify(logEntry));
      break;
  }
}
