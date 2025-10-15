// Centralized Security Service
//
// **Security Model**: Trust container isolation, only protect SDK control plane
//
// Philosophy:
// - Container isolation handles system-level security
// - Users have full control over their sandbox (it's the value proposition!)
// - Only protect port 3000 (SDK control plane) from interference
// - Format validation only (null bytes, length limits)
// - No content restrictions (no path blocking, no command blocking, no URL allowlists)
import type { Logger, ValidationResult } from '../core/types';

export class SecurityService {
  // Only port 3000 is truly reserved (SDK control plane)
  // This is REAL security - prevents control plane interference
  private static readonly RESERVED_PORTS = [
    3000, // Container control plane (API endpoints) - MUST be protected
  ];

  constructor(private logger: Logger) {}

  /**
   * Validate path format (not content)
   * - No system directory blocking (users control their sandbox!)
   * - No directory traversal blocking (container isolation handles this)
   * - Only format validation (null bytes, length limits)
   */
  validatePath(path: string): ValidationResult<string> {
    const errors: string[] = [];

    // Basic validation
    if (!path || typeof path !== 'string') {
      errors.push('Path must be a non-empty string');
      return { isValid: false, errors: errors.map(e => ({ field: 'path', message: e, code: 'INVALID_PATH' })) };
    }

    // Only validate format, not content
    if (path.includes('\0')) {
      errors.push('Path contains null bytes');
    }

    if (path.length > 4096) {
      errors.push('Path too long (max 4096 characters)');
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({
      field: 'path',
      message: e,
      code: 'INVALID_PATH'
    }));

    if (!isValid) {
      this.logger.warn('Path validation failed', {
        path,
        errors
      });
    }

    if (isValid) {
      return {
        isValid: true,
        errors: validationErrors,
        data: path
      };
    } else {
      return {
        isValid: false,
        errors: validationErrors
      };
    }
  }

  /**
   * Validate port number
   * - Protects port 3000 (SDK control plane) - CRITICAL!
   * - Range validation (1-65535)
   * - No arbitrary port restrictions (users control their sandbox!)
   */
  validatePort(port: number): ValidationResult<number> {
    const errors: string[] = [];

    // Basic validation
    if (!Number.isInteger(port)) {
      errors.push('Port must be an integer');
    } else {
      // Port range validation
      if (port < 1 || port > 65535) {
        errors.push('Port must be between 1 and 65535');
      }

      // CRITICAL: Protect SDK control plane
      if (SecurityService.RESERVED_PORTS.includes(port)) {
        errors.push(`Port ${port} is reserved for the sandbox API control plane`);
      }
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({
      field: 'port',
      message: e,
      code: 'INVALID_PORT'
    }));

    if (!isValid) {
      this.logger.warn('Port validation failed', { port, errors });
    }

    if (isValid) {
      return {
        isValid: true,
        errors: validationErrors,
        data: port
      };
    } else {
      return {
        isValid: false,
        errors: validationErrors
      };
    }
  }

  /**
   * Validate command format (not content)
   * - No command blocking (users can run bash, sudo, rm -rf - it's their sandbox!)
   * - Only format validation (null bytes, length limits)
   * - Container isolation provides real security
   */
  validateCommand(command: string): ValidationResult<string> {
    const errors: string[] = [];

    // Basic validation
    if (!command || typeof command !== 'string') {
      errors.push('Command must be a non-empty string');
      return { isValid: false, errors: errors.map(e => ({ field: 'command', message: e, code: 'INVALID_COMMAND' })) };
    }

    const trimmedCommand = command.trim();

    if (trimmedCommand.length === 0) {
      errors.push('Command cannot be empty');
    }

    if (trimmedCommand.length > 8192) {
      errors.push('Command too long (max 8192 characters)');
    }

    if (trimmedCommand.includes('\0')) {
      errors.push('Command contains null bytes');
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({
      field: 'command',
      message: e,
      code: 'INVALID_COMMAND'
    }));

    if (!isValid) {
      this.logger.warn('Command validation failed', {
        command: trimmedCommand,
        errors
      });
    }

    if (isValid) {
      return {
        isValid: true,
        errors: validationErrors,
        data: trimmedCommand
      };
    } else {
      return {
        isValid: false,
        errors: validationErrors
      };
    }
  }

  /**
   * Validate Git URL format (not content)
   * - No URL allowlist (users can use private repos, self-hosted Git)
   * - Only format validation (null bytes, length limits)
   * - Trust users to provide valid Git URLs
   */
  validateGitUrl(url: string): ValidationResult<string> {
    const errors: string[] = [];

    // Basic validation
    if (!url || typeof url !== 'string') {
      errors.push('Git URL must be a non-empty string');
      return { isValid: false, errors: errors.map(e => ({ field: 'gitUrl', message: e, code: 'INVALID_GIT_URL' })) };
    }

    const trimmedUrl = url.trim();

    if (trimmedUrl.length === 0) {
      errors.push('Git URL cannot be empty');
    }

    if (trimmedUrl.length > 2048) {
      errors.push('Git URL too long (max 2048 characters)');
    }

    if (trimmedUrl.includes('\0')) {
      errors.push('Git URL contains null bytes');
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({
      field: 'gitUrl',
      message: e,
      code: 'INVALID_GIT_URL'
    }));

    if (!isValid) {
      this.logger.warn('Git URL validation failed', {
        gitUrl: trimmedUrl,
        errors
      });
    }

    if (isValid) {
      return {
        isValid: true,
        errors: validationErrors,
        data: trimmedUrl
      };
    } else {
      return {
        isValid: false,
        errors: validationErrors
      };
    }
  }

  // Helper methods

  generateSecureSessionId(): string {
    // Use crypto.randomBytes for secure session ID generation
    const timestamp = Date.now();
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    const randomHex = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return `session_${timestamp}_${randomHex}`;
  }

  // Method to log security events for monitoring
  logSecurityEvent(event: string, details: Record<string, unknown>): void {
    this.logger.warn(`SECURITY_EVENT: ${event}`, {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    });
  }
}
