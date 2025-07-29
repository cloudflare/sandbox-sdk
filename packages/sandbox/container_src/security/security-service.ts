// Centralized Security Service
import type { ValidationResult, Logger } from '../core/types';

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
    /rm\s+-rf\s+\//,           // Recursive delete from root
    /sudo/,                    // Privilege escalation
    /su\s/,                    // Switch user
    /passwd/,                  // Change password
    /useradd/,                 // Add user
    /userdel/,                 // Delete user
    /usermod/,                 // Modify user
    /chmod\s+777/,             // Dangerous permissions
    /chown\s+root/,            // Change to root ownership
    /\/etc\/passwd/,           // System password file
    /\/etc\/shadow/,           // System shadow file
    /mkfs/,                    // Format filesystem
    /dd\s+if=/,                // Direct disk access
    /mount/,                   // Mount filesystems
    /umount/,                  // Unmount filesystems
    /init\s+0/,                // Shutdown system
    /shutdown/,                // Shutdown system
    /reboot/,                  // Reboot system
    /halt/,                    // Halt system
    /systemctl/,               // System control
    /service\s/,               // Service control
    /crontab/,                 // Cron jobs
    /at\s/,                    // Scheduled tasks
    /nohup.*&/,                // Background processes
    /\&\&.*rm/,                // Chained dangerous commands
    /\|\|.*rm/,                // Alternative dangerous commands
    /exec.*bash/,              // Execute shell
    /exec.*sh/,                // Execute shell
    /\/bin\/bash/,             // Direct shell access
    /\/bin\/sh/,               // Direct shell access
    /curl.*\|.*bash/,          // Pipe to shell
    /wget.*\|.*bash/,          // Pipe to shell
    /eval/,                    // Dynamic evaluation
    /nc\s+-l/,                 // Netcat listener
    /netcat\s+-l/,             // Netcat listener
  ];

  // Valid Git URL patterns
  private static readonly VALID_GIT_PATTERNS = [
    /^https:\/\/github\.com\/[\w\.-]+\/[\w\.-]+(?:\.git)?$/,
    /^https:\/\/gitlab\.com\/[\w\.-]+\/[\w\.-]+(?:\.git)?$/,
    /^https:\/\/bitbucket\.org\/[\w\.-]+\/[\w\.-]+(?:\.git)?$/,
    /^git@github\.com:[\w\.-]+\/[\w\.-]+\.git$/,
    /^git@gitlab\.com:[\w\.-]+\/[\w\.-]+\.git$/,
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

    return { 
      isValid, 
      errors: validationErrors,
      data: isValid ? normalizedPath : undefined 
    };
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

    return { 
      isValid, 
      errors: validationErrors,
      data: isValid ? port : undefined 
    };
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

    // Check for shell injection attempts
    const suspiciousChars = /[;&|`$(){}[\]<>]/;
    if (suspiciousChars.test(trimmedCommand)) {
      // Allow some safe uses but be restrictive
      const allowedPatterns = [
        /^ls\s+-[a-zA-Z]+$/,          // ls with flags
        /^echo\s+"[^"]*"$/,           // echo with quoted strings
        /^cat\s+[\w\/\.-]+\s*\|?\s*head$/,  // cat with pipe to head
        /^grep\s+"[^"]*"\s+[\w\/\.-]+$/,    // grep with quoted pattern
      ];

      const isAllowed = allowedPatterns.some(pattern => pattern.test(trimmedCommand));
      if (!isAllowed) {
        errors.push('Command contains potentially dangerous shell characters');
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

    return { 
      isValid, 
      errors: validationErrors,
      data: isValid ? trimmedCommand : undefined 
    };
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

    return { 
      isValid, 
      errors: validationErrors,
      data: isValid ? trimmedUrl : undefined 
    };
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