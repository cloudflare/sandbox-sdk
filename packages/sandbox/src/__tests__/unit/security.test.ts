import { 
  logSecurityEvent, 
  SecurityError,
  sanitizeSandboxId,
  validatePort 
} from '../../security';

describe('Security Module', () => {
  describe('SecurityError', () => {
    it('should create error with message and code', () => {
      const error = new SecurityError('Test error', 'TEST_CODE');
      
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('SecurityError');
      expect(error).toBeInstanceOf(Error);
    });

    it('should create error without code', () => {
      const error = new SecurityError('Test error');
      
      expect(error.message).toBe('Test error');
      expect(error.code).toBeUndefined();
      expect(error.name).toBe('SecurityError');
    });
  });

  describe('validatePort', () => {
    describe('valid ports', () => {
      it('should accept standard application ports', () => {
        expect(validatePort(1024)).toBe(true);
        expect(validatePort(3001)).toBe(true);
        expect(validatePort(8080)).toBe(true);
        expect(validatePort(9000)).toBe(true);
        expect(validatePort(65535)).toBe(true);
      });

      it('should accept commonly used development ports', () => {
        expect(validatePort(3001)).toBe(true);
        expect(validatePort(4000)).toBe(true);
        expect(validatePort(5000)).toBe(true);
        expect(validatePort(8000)).toBe(true);
        expect(validatePort(8080)).toBe(true);
        expect(validatePort(9000)).toBe(true);
      });
    });

    describe('invalid ports', () => {
      it('should reject system ports (< 1024)', () => {
        expect(validatePort(0)).toBe(false);
        expect(validatePort(22)).toBe(false);   // SSH
        expect(validatePort(80)).toBe(false);   // HTTP
        expect(validatePort(443)).toBe(false);  // HTTPS
        expect(validatePort(993)).toBe(false);  // IMAPS
        expect(validatePort(1023)).toBe(false); // Last system port
      });

      it('should reject ports above valid range', () => {
        expect(validatePort(65536)).toBe(false);
        expect(validatePort(70000)).toBe(false);
        expect(validatePort(99999)).toBe(false);
      });

      it('should reject reserved system ports', () => {
        expect(validatePort(3000)).toBe(false); // Control plane
        expect(validatePort(8787)).toBe(false); // Wrangler dev port
      });

      it('should reject non-integer values', () => {
        expect(validatePort(3000.5)).toBe(false);
        expect(validatePort(NaN)).toBe(false);
        expect(validatePort(Infinity)).toBe(false);
        expect(validatePort(-Infinity)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle boundary values', () => {
        expect(validatePort(1023)).toBe(false); // Just below valid range
        expect(validatePort(1024)).toBe(true);  // First valid port
        expect(validatePort(65535)).toBe(true); // Last valid port
        expect(validatePort(65536)).toBe(false); // Just above valid range
      });
    });
  });

  describe('sanitizeSandboxId', () => {
    describe('valid sandbox IDs', () => {
      it('should accept simple alphanumeric IDs', () => {
        expect(sanitizeSandboxId('abc123')).toBe('abc123');
        expect(sanitizeSandboxId('test-sandbox')).toBe('test-sandbox');
        expect(sanitizeSandboxId('MyProject')).toBe('MyProject');
        expect(sanitizeSandboxId('a')).toBe('a'); // Single character
      });

      it('should accept IDs with hyphens in middle', () => {
        expect(sanitizeSandboxId('my-project')).toBe('my-project');
        expect(sanitizeSandboxId('test-env-1')).toBe('test-env-1');
        expect(sanitizeSandboxId('a-b-c')).toBe('a-b-c');
      });

      it('should accept maximum length IDs (63 characters)', () => {
        const maxLengthId = 'a'.repeat(63);
        expect(sanitizeSandboxId(maxLengthId)).toBe(maxLengthId);
      });
    });

    describe('invalid sandbox IDs - length validation', () => {
      it('should reject empty strings', () => {
        expect(() => sanitizeSandboxId('')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('')).toThrow('Sandbox ID must be 1-63 characters long.');
      });

      it('should reject IDs longer than 63 characters', () => {
        const tooLongId = 'a'.repeat(64);
        expect(() => sanitizeSandboxId(tooLongId)).toThrow(SecurityError);
        expect(() => sanitizeSandboxId(tooLongId)).toThrow('Sandbox ID must be 1-63 characters long.');
      });

      it('should provide correct error code for length violations', () => {
        try {
          sanitizeSandboxId('');
        } catch (error) {
          expect(error).toBeInstanceOf(SecurityError);
          expect((error as SecurityError).code).toBe('INVALID_SANDBOX_ID_LENGTH');
        }
      });
    });

    describe('invalid sandbox IDs - hyphen validation', () => {
      it('should reject IDs starting with hyphens', () => {
        expect(() => sanitizeSandboxId('-invalid')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('-test-id')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('-')).toThrow(SecurityError);
      });

      it('should reject IDs ending with hyphens', () => {
        expect(() => sanitizeSandboxId('invalid-')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('test-id-')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('-')).toThrow(SecurityError);
      });

      it('should provide correct error message for hyphen violations', () => {
        expect(() => sanitizeSandboxId('-invalid')).toThrow(
          'Sandbox ID cannot start or end with hyphens (DNS requirement).'
        );
        expect(() => sanitizeSandboxId('invalid-')).toThrow(
          'Sandbox ID cannot start or end with hyphens (DNS requirement).'
        );
      });

      it('should provide correct error code for hyphen violations', () => {
        try {
          sanitizeSandboxId('-invalid');
        } catch (error) {
          expect(error).toBeInstanceOf(SecurityError);
          expect((error as SecurityError).code).toBe('INVALID_SANDBOX_ID_HYPHENS');
        }
      });
    });

    describe('invalid sandbox IDs - reserved names', () => {
      it('should reject reserved names (case insensitive)', () => {
        const reservedNames = ['www', 'api', 'admin', 'root', 'system', 'cloudflare', 'workers'];
        
        for (const name of reservedNames) {
          expect(() => sanitizeSandboxId(name)).toThrow(SecurityError);
          expect(() => sanitizeSandboxId(name.toUpperCase())).toThrow(SecurityError);
          expect(() => sanitizeSandboxId(name.charAt(0).toUpperCase() + name.slice(1))).toThrow(SecurityError);
        }
      });

      it('should provide correct error message for reserved names', () => {
        expect(() => sanitizeSandboxId('admin')).toThrow(
          "Reserved sandbox ID 'admin' is not allowed."
        );
        expect(() => sanitizeSandboxId('API')).toThrow(
          "Reserved sandbox ID 'API' is not allowed."
        );
      });

      it('should provide correct error code for reserved names', () => {
        try {
          sanitizeSandboxId('www');
        } catch (error) {
          expect(error).toBeInstanceOf(SecurityError);
          expect((error as SecurityError).code).toBe('RESERVED_SANDBOX_ID');
        }
      });
    });

    describe('edge cases', () => {
      it('should handle mixed case reserved names', () => {
        expect(() => sanitizeSandboxId('Admin')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('SYSTEM')).toThrow(SecurityError);
        expect(() => sanitizeSandboxId('CloudFlare')).toThrow(SecurityError);
      });

      it('should allow names that contain but are not exactly reserved words', () => {
        expect(sanitizeSandboxId('www-test')).toBe('www-test');
        expect(sanitizeSandboxId('api-v1')).toBe('api-v1');
        expect(sanitizeSandboxId('my-admin')).toBe('my-admin');
        expect(sanitizeSandboxId('test-system')).toBe('test-system');
      });
    });
  });

  describe('logSecurityEvent', () => {
    let consoleSpy: {
      error: ReturnType<typeof vi.spyOn>;
      warn: ReturnType<typeof vi.spyOn>;
      info: ReturnType<typeof vi.spyOn>;
    };

    beforeEach(() => {
      consoleSpy = {
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      consoleSpy.error.mockRestore();
      consoleSpy.warn.mockRestore();
      consoleSpy.info.mockRestore();
    });

    it('should log critical events to console.error', () => {
      logSecurityEvent('Test Event', { userId: '123' }, 'critical');
      
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[SECURITY:CRITICAL] Test Event:',
        expect.stringContaining('"event":"Test Event"')
      );
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[SECURITY:CRITICAL] Test Event:',
        expect.stringContaining('"severity":"critical"')
      );
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[SECURITY:CRITICAL] Test Event:',
        expect.stringContaining('"userId":"123"')
      );
    });

    it('should log high severity events to console.error', () => {
      logSecurityEvent('High Priority Event', { action: 'blocked' }, 'high');
      
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledWith(
        '[SECURITY:HIGH] High Priority Event:',
        expect.stringContaining('"severity":"high"')
      );
    });

    it('should log medium severity events to console.warn (default)', () => {
      logSecurityEvent('Medium Event', { ip: '192.168.1.1' });
      
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '[SECURITY:MEDIUM] Medium Event:',
        expect.stringContaining('"severity":"medium"')
      );
    });

    it('should log medium severity events to console.warn (explicit)', () => {
      logSecurityEvent('Medium Event', { ip: '192.168.1.1' }, 'medium');
      
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        '[SECURITY:MEDIUM] Medium Event:',
        expect.stringContaining('"severity":"medium"')
      );
    });

    it('should log low severity events to console.info', () => {
      logSecurityEvent('Low Priority Event', { session: 'abc123' }, 'low');
      
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.info).toHaveBeenCalledWith(
        '[SECURITY:LOW] Low Priority Event:',
        expect.stringContaining('"severity":"low"')
      );
    });

    it('should include timestamp in log entries', () => {
      logSecurityEvent('Timestamp Test', {}, 'low');
      
      expect(consoleSpy.info).toHaveBeenCalledWith(
        '[SECURITY:LOW] Timestamp Test:',
        expect.stringMatching(/"timestamp":"20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/)
      );
    });

    it('should merge event details into log entry', () => {
      logSecurityEvent('Complex Event', {
        userId: '123',
        action: 'login_attempt',
        ip: '192.168.1.1',
        userAgent: 'TestAgent'
      }, 'medium');
      
      const loggedMessage = consoleSpy.warn.mock.calls[0][1];
      expect(loggedMessage).toContain('"userId":"123"');
      expect(loggedMessage).toContain('"action":"login_attempt"');
      expect(loggedMessage).toContain('"ip":"192.168.1.1"');
      expect(loggedMessage).toContain('"userAgent":"TestAgent"');
    });

    it('should handle empty details object', () => {
      logSecurityEvent('Empty Details', {}, 'low');
      
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.info).toHaveBeenCalledWith(
        '[SECURITY:LOW] Empty Details:',
        expect.stringContaining('"event":"Empty Details"')
      );
    });

    it('should handle complex nested objects in details', () => {
      logSecurityEvent('Nested Event', {
        user: { id: '123', name: 'John' },
        metadata: { tags: ['test', 'security'] }
      }, 'medium');
      
      const loggedMessage = consoleSpy.warn.mock.calls[0][1];
      expect(loggedMessage).toContain('"user":{"id":"123","name":"John"}');
      expect(loggedMessage).toContain('"metadata":{"tags":["test","security"]}');
    });
  });
});