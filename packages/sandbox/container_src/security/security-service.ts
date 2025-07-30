// Centralized Security Service
import type { Logger, ValidationResult } from '../core/types';

export class SecurityService {
  // Dangerous path patterns that should be blocked
  private static readonly DANGEROUS_PATTERNS = [
    /^\/$/,           // Root directory
    /^\/etc/,         // System config
    /^\/var/,         // Variable data
    /^\/usr/,         // User programs
    /^\/bin/,         // System binaries
    /^\/sbin/,        // System admin binaries
    /^\/boot/,        // Boot files
    /^\/dev/,         // Device files
    /^\/proc/,        // Process info
    /^\/sys/,         // System info
    /^tmp\/\.\./,     // Directory traversal in temp
    /\.\./,           // Directory traversal anywhere
    /\/\.\./,         // Directory traversal
    /\.\.$/,          // Ends with directory traversal
    /\/$/,            // Ends with slash (potential dir traversal)
  ];

  // Reserved/dangerous ports that should not be exposed
  private static readonly RESERVED_PORTS = [
    // System ports (0-1023)
    22,   // SSH
    25,   // SMTP  
    53,   // DNS
    80,   // HTTP
    110,  // POP3
    143,  // IMAP
    443,  // HTTPS
    993,  // IMAPS
    995,  // POP3S
    
    // Common database ports
    3306, // MySQL
    5432, // PostgreSQL
    6379, // Redis
    27017, // MongoDB
    
    // Container/orchestration ports
    2375, // Docker daemon (insecure)
    2376, // Docker daemon (secure)  
    6443, // Kubernetes API
    8080, // Common alternative HTTP
    9000, // Various services
  ];

  // Dangerous command patterns
  private static readonly DANGEROUS_COMMANDS = [
    // Critical system destruction
    /rm\s+-rf\s+\/$/,          // Delete entire root filesystem
    /rm\s+-rf\s+\/\s/,         // Delete root with trailing content  
    /rm\s+-rf\s+\*$/,          // Delete everything in current dir
    
    // Privilege escalation (actual security risks)
    /^sudo(\s|$)/,             // Privilege escalation
    /^su(\s|$)/,               // Switch user
    
    // System password/user modification
    /^passwd(\s|$)/,           // Change passwords
    /^useradd(\s|$)/,          // Add users
    /^userdel(\s|$)/,          // Delete users
    /^usermod(\s|$)/,          // Modify users
    
    // Critical system file access
    /\/etc\/passwd/,           // System password file
    /\/etc\/shadow/,           // System shadow file
    
    // Filesystem operations
    /^mkfs(\s|\.)/,            // Format filesystem (mkfs or mkfs.ext4)
    /^mount(\s|$)/,            // Mount filesystems
    /^umount(\s|$)/,           // Unmount filesystems
    /^chmod\s+777/,            // Dangerous permissions
    /^chown\s+root/,           // Change to root ownership
    /^dd\s+if=/,               // Direct disk access
    
    // System control
    /^init\s+0/,               // Shutdown system via init
    /^shutdown/,               // Shutdown system
    /^reboot/,                 // Reboot system
    /^halt/,                   // Halt system
    /^systemctl(\s|$)/,        // System control
    /^service\s/,              // Service control
    
    // Shell execution (direct shell access)
    /^exec\s+(bash|sh)/,       // Execute shell
    /^\/bin\/(bash|sh)$/,      // Direct shell access
    /^bash$/,                  // Direct bash
    /^sh$/,                    // Direct sh
    
    // Remote code execution patterns
    /curl.*\|\s*(bash|sh)/,    // Download and execute
    /wget.*\|\s*(bash|sh)/,    // Download and execute
    /\|\s*bash$/,              // Pipe to bash
    /\|\s*sh$/,                // Pipe to shell
    
    // Process injection/evaluation
    /^eval\s/,                 // Dynamic evaluation
    /^nc\s+-l/,                // Netcat listener
    /netcat\s+-l/,             // Netcat listener
  ];

  // Valid Git URL patterns
  private static readonly VALID_GIT_PATTERNS = [
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
    /^https:\/\/gitlab\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
    /^https:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+(?:\.git)?$/,
    /^git@github\.com:[\w.-]+\/[\w.-]+\.git$/,
    /^git@gitlab\.com:[\w.-]+\/[\w.-]+\.git$/,
  ];

  constructor(private logger: Logger) {}

  validatePath(path: string): ValidationResult<string> {
    const errors: string[] = [];

    // Basic validation
    if (!path || typeof path !== 'string') {
      errors.push('Path must be a non-empty string');
      return { isValid: false, errors: errors.map(e => ({ field: 'path', message: e, code: 'INVALID_PATH' })) };
    }

    // Normalize path
    const normalizedPath = this.normalizePath(path);

    // Check against dangerous patterns
    for (const pattern of SecurityService.DANGEROUS_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        errors.push(`Path matches dangerous pattern: ${pattern.source}`);
        this.logger.warn('Dangerous path access attempt', { 
          originalPath: path, 
          normalizedPath, 
          pattern: pattern.source 
        });
      }
    }

    // Additional checks
    if (normalizedPath.includes('\0')) {
      errors.push('Path contains null bytes');
    }

    if (normalizedPath.length > 4096) {
      errors.push('Path too long (max 4096 characters)');
    }

    // Check for executable extensions in sensitive locations
    if (normalizedPath.match(/\.(sh|bash|exe|bat|cmd|ps1)$/i) && 
        normalizedPath.startsWith('/tmp/')) {
      errors.push('Executable files not allowed in temporary directories');
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({ 
      field: 'path', 
      message: e, 
      code: 'PATH_SECURITY_VIOLATION' 
    }));

    if (!isValid) {
      this.logger.warn('Path validation failed', { 
        path, 
        normalizedPath, 
        errors 
      });
    }

    if (isValid) {
      return {
        isValid: true,
        errors: validationErrors,
        data: normalizedPath
      };
    } else {
      return {
        isValid: false,
        errors: validationErrors
      };
    }
  }

  sanitizePath(path: string): string {
    if (!path || typeof path !== 'string') {
      return '';
    }

    // Remove null bytes
    let sanitized = path.replace(/\0/g, '');
    
    // Normalize path separators
    sanitized = sanitized.replace(/\\/g, '/');
    
    // Remove multiple consecutive slashes
    sanitized = sanitized.replace(/\/+/g, '/');
    
    // Remove trailing slash (except for root)
    if (sanitized.length > 1 && sanitized.endsWith('/')) {
      sanitized = sanitized.slice(0, -1);
    }

    // Resolve directory traversal attempts
    const parts = sanitized.split('/');
    const resolved: string[] = [];
    
    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      }
      if (part === '..') {
        if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
          resolved.pop();
        }
        continue;
      }
      resolved.push(part);
    }

    const result = '/' + resolved.join('/');
    
    if (result !== path) {
      this.logger.info('Path sanitized', { original: path, sanitized: result });
    }

    return result;
  }

  validatePort(port: number): ValidationResult<number> {
    const errors: string[] = [];

    // Basic validation
    if (!Number.isInteger(port)) {
      errors.push('Port must be an integer');
    } else {
      // Port range validation
      if (port < 1024 || port > 65535) {
        errors.push('Port must be between 1024 and 65535');
      }

      // Check reserved ports
      if (SecurityService.RESERVED_PORTS.includes(port)) {
        errors.push(`Port ${port} is reserved and cannot be exposed`);
      }

      // Additional high-risk ports
      if (port === 3000) {
        errors.push('Port 3000 is reserved for the container control plane');
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

    // Check against dangerous command patterns
    for (const pattern of SecurityService.DANGEROUS_COMMANDS) {
      if (pattern.test(trimmedCommand)) {
        errors.push(`Command matches dangerous pattern: ${pattern.source}`);
        this.logger.warn('Dangerous command execution attempt', { 
          command: trimmedCommand, 
          pattern: pattern.source 
        });
      }
    }

    // Additional checks
    if (trimmedCommand.includes('\0')) {
      errors.push('Command contains null bytes');
    }

    // Check for specific shell injection patterns (be permissive for development)
    const dangerousShellPatterns = [
      /;\s*(rm|sudo|passwd|shutdown)/,  // Command chaining with dangerous commands
      /\|\s*(rm|sudo|passwd|shutdown)/, // Piping to dangerous commands
      /&&\s*(rm|sudo|passwd|shutdown)/, // AND chaining with dangerous commands
      /\|\|\s*(rm|sudo|passwd|shutdown)/, // OR chaining with dangerous commands
      /`.*sudo/,                        // Command substitution with sudo
      /\$\(.*sudo/,                     // Command substitution with sudo
      /`.*rm\s+-rf/,                    // Command substitution with rm -rf
      /\$\(.*rm\s+-rf/,                 // Command substitution with rm -rf
      /\$\{IFS\}/,                      // Shell variable manipulation (bypass attempt)
    ];

    for (const pattern of dangerousShellPatterns) {
      if (pattern.test(trimmedCommand)) {
        errors.push('Command contains dangerous shell injection pattern');
        break;
      }
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({ 
      field: 'command', 
      message: e, 
      code: 'COMMAND_SECURITY_VIOLATION' 
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

    // Check against valid Git URL patterns
    const isValidPattern = SecurityService.VALID_GIT_PATTERNS.some(pattern => 
      pattern.test(trimmedUrl)
    );

    if (!isValidPattern) {
      errors.push('Git URL must be from a trusted provider (GitHub, GitLab, Bitbucket)');
    }

    // Additional security checks
    if (trimmedUrl.includes('\0')) {
      errors.push('Git URL contains null bytes');
    }

    // Check for suspicious characters
    if (/[<>|&;`$(){}[\]]/.test(trimmedUrl)) {
      errors.push('Git URL contains suspicious characters');
    }

    const isValid = errors.length === 0;
    const validationErrors = errors.map(e => ({ 
      field: 'gitUrl', 
      message: e, 
      code: 'GIT_URL_SECURITY_VIOLATION' 
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

  // Additional helper methods

  isPathInAllowedDirectory(path: string, allowedDirs: string[] = ['/tmp', '/home', '/workspace']): boolean {
    const normalizedPath = this.normalizePath(path);
    return allowedDirs.some(dir => normalizedPath.startsWith(dir));
  }

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

  hashSensitiveData(data: string): string {
    // Simple hash for logging sensitive data (not cryptographically secure)
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `hash_${Math.abs(hash).toString(16)}`;
  }

  private normalizePath(path: string): string {
    // Convert backslashes to forward slashes
    let normalized = path.replace(/\\/g, '/');
    
    // Remove multiple consecutive slashes
    normalized = normalized.replace(/\/+/g, '/');
    
    // Always start with /
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    return normalized;
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