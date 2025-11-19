import { beforeEach, describe, expect, it } from 'bun:test';
import { ErrorCode } from '@repo/shared/errors';
import type { PortInfo } from '@sandbox-container/core/types';
import { PortManager } from '@sandbox-container/managers/port-manager';

describe('PortManager', () => {
  let manager: PortManager;

  beforeEach(() => {
    manager = new PortManager();
  });

  describe('calculateCleanupThreshold', () => {
    it('should return date 1 hour ago', () => {
      const before = new Date(Date.now() - 60 * 60 * 1000 - 100);
      const threshold = manager.calculateCleanupThreshold();
      const after = new Date(Date.now() - 60 * 60 * 1000 + 100);

      expect(threshold.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(threshold.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('parseProxyPath', () => {
    it('should parse basic proxy URL correctly', () => {
      const result = manager.parseProxyPath(
        'http://example.com/proxy/8080/api/test',
        8080
      );

      expect(result.targetPath).toBe('api/test');
      expect(result.targetUrl).toBe('http://localhost:8080/api/test');
    });

    it('should parse proxy URL with query parameters', () => {
      const result = manager.parseProxyPath(
        'http://example.com/proxy/8080/api/test?param=value&foo=bar',
        8080
      );

      expect(result.targetPath).toBe('api/test');
      expect(result.targetUrl).toBe(
        'http://localhost:8080/api/test?param=value&foo=bar'
      );
    });

    it('should parse root path proxy correctly', () => {
      const result = manager.parseProxyPath(
        'http://example.com/proxy/8080/',
        8080
      );

      expect(result.targetPath).toBe('');
      expect(result.targetUrl).toBe('http://localhost:8080/');
    });

    it('should parse nested path correctly', () => {
      const result = manager.parseProxyPath(
        'http://example.com/proxy/3000/api/v1/users/123',
        3000
      );

      expect(result.targetPath).toBe('api/v1/users/123');
      expect(result.targetUrl).toBe('http://localhost:3000/api/v1/users/123');
    });

    it('should handle paths with special characters', () => {
      const result = manager.parseProxyPath(
        'http://example.com/proxy/8080/path%20with%20spaces',
        8080
      );

      expect(result.targetPath).toBe('path%20with%20spaces');
      expect(result.targetUrl).toBe(
        'http://localhost:8080/path%20with%20spaces'
      );
    });
  });

  describe('createPortInfo', () => {
    it('should create PortInfo with port and name', () => {
      const portInfo = manager.createPortInfo(8080, 'web-server');

      expect(portInfo.port).toBe(8080);
      expect(portInfo.name).toBe('web-server');
      expect(portInfo.status).toBe('active');
      expect(portInfo.exposedAt).toBeInstanceOf(Date);
    });

    it('should create PortInfo without name', () => {
      const portInfo = manager.createPortInfo(3000);

      expect(portInfo.port).toBe(3000);
      expect(portInfo.name).toBeUndefined();
      expect(portInfo.status).toBe('active');
    });
  });

  describe('createInactivePortInfo', () => {
    it('should update status to inactive while preserving other fields', () => {
      const existingInfo: PortInfo = {
        port: 8080,
        name: 'web-server',
        exposedAt: new Date('2024-01-01'),
        status: 'active'
      };

      const inactiveInfo = manager.createInactivePortInfo(existingInfo);

      expect(inactiveInfo.port).toBe(8080);
      expect(inactiveInfo.name).toBe('web-server');
      expect(inactiveInfo.exposedAt).toEqual(new Date('2024-01-01'));
      expect(inactiveInfo.status).toBe('inactive');
    });
  });

  describe('determineErrorCode', () => {
    it('should return PORT_NOT_FOUND for not found errors', () => {
      expect(
        manager.determineErrorCode('get', new Error('Port not found'))
      ).toBe('PORT_NOT_FOUND');
      expect(manager.determineErrorCode('get', new Error('ENOENT'))).toBe(
        'PORT_NOT_FOUND'
      );
    });

    it('should return PORT_ALREADY_EXPOSED for already exposed errors', () => {
      expect(
        manager.determineErrorCode('expose', new Error('Port already exposed'))
      ).toBe('PORT_ALREADY_EXPOSED');
      expect(
        manager.determineErrorCode('expose', new Error('Conflict detected'))
      ).toBe('PORT_ALREADY_EXPOSED');
    });

    it('should return CONNECTION_REFUSED for connection errors', () => {
      expect(
        manager.determineErrorCode('proxy', new Error('Connection refused'))
      ).toBe('CONNECTION_REFUSED');
      expect(
        manager.determineErrorCode('proxy', new Error('ECONNREFUSED'))
      ).toBe('CONNECTION_REFUSED');
    });

    it('should return CONNECTION_TIMEOUT for timeout errors', () => {
      expect(
        manager.determineErrorCode('proxy', new Error('Request timeout'))
      ).toBe('CONNECTION_TIMEOUT');
      expect(manager.determineErrorCode('proxy', new Error('ETIMEDOUT'))).toBe(
        'CONNECTION_TIMEOUT'
      );
    });

    it('should return operation-specific error codes as fallback', () => {
      expect(
        manager.determineErrorCode('expose', new Error('Unknown error'))
      ).toBe('PORT_EXPOSE_ERROR');
      expect(
        manager.determineErrorCode('unexpose', new Error('Unknown error'))
      ).toBe('PORT_UNEXPOSE_ERROR');
      expect(
        manager.determineErrorCode('list', new Error('Unknown error'))
      ).toBe(ErrorCode.PORT_OPERATION_ERROR);
      expect(
        manager.determineErrorCode('get', new Error('Unknown error'))
      ).toBe('PORT_GET_ERROR');
      expect(
        manager.determineErrorCode('proxy', new Error('Unknown error'))
      ).toBe('PROXY_ERROR');
      expect(
        manager.determineErrorCode('update', new Error('Unknown error'))
      ).toBe('PORT_UPDATE_ERROR');
      expect(
        manager.determineErrorCode('cleanup', new Error('Unknown error'))
      ).toBe('PORT_CLEANUP_ERROR');
    });
  });

  describe('createErrorMessage', () => {
    it('should create error message for expose operation', () => {
      const message = manager.createErrorMessage(
        'expose',
        8080,
        'Port already in use'
      );

      expect(message).toBe('Failed to expose port 8080: Port already in use');
    });

    it('should create error message for unexpose operation', () => {
      const message = manager.createErrorMessage('unexpose', 3000, 'Not found');

      expect(message).toBe('Failed to unexpose port 3000: Not found');
    });

    it('should create error message for proxy operation', () => {
      const message = manager.createErrorMessage(
        'proxy',
        8080,
        'Connection refused'
      );

      expect(message).toBe(
        'Failed to proxy request to port 8080: Connection refused'
      );
    });
  });

  describe('isValidPortRange', () => {
    it('should return true for valid port numbers', () => {
      expect(manager.isValidPortRange(1)).toBe(true);
      expect(manager.isValidPortRange(1024)).toBe(true);
      expect(manager.isValidPortRange(8080)).toBe(true);
      expect(manager.isValidPortRange(65535)).toBe(true);
    });

    it('should return false for invalid port numbers', () => {
      expect(manager.isValidPortRange(0)).toBe(false);
      expect(manager.isValidPortRange(-1)).toBe(false);
      expect(manager.isValidPortRange(65536)).toBe(false);
    });
  });

  describe('formatPortList', () => {
    it('should format single port correctly', () => {
      const ports = [
        {
          port: 8080,
          info: {
            port: 8080,
            name: 'web-server',
            exposedAt: new Date(),
            status: 'active' as const
          }
        }
      ];

      const formatted = manager.formatPortList(ports);

      expect(formatted).toBe('8080 (web-server, active)');
    });

    it('should format multiple ports correctly', () => {
      const ports = [
        {
          port: 8080,
          info: {
            port: 8080,
            name: 'web-server',
            exposedAt: new Date(),
            status: 'active' as const
          }
        },
        {
          port: 3000,
          info: {
            port: 3000,
            name: 'api-server',
            exposedAt: new Date(),
            status: 'inactive' as const
          }
        }
      ];

      const formatted = manager.formatPortList(ports);

      expect(formatted).toBe(
        '8080 (web-server, active), 3000 (api-server, inactive)'
      );
    });

    it('should handle unnamed ports', () => {
      const ports = [
        {
          port: 8080,
          info: {
            port: 8080,
            exposedAt: new Date(),
            status: 'active' as const
          }
        }
      ];

      const formatted = manager.formatPortList(ports);

      expect(formatted).toBe('8080 (unnamed, active)');
    });

    it('should return empty string for empty port list', () => {
      const formatted = manager.formatPortList([]);

      expect(formatted).toBe('');
    });
  });

  describe('shouldCleanupPort', () => {
    it('should return true for inactive port older than threshold', () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const threshold = new Date('2024-01-01T12:00:00Z');

      const portInfo: PortInfo = {
        port: 8080,
        exposedAt: oldDate,
        status: 'inactive'
      };

      expect(manager.shouldCleanupPort(portInfo, threshold)).toBe(true);
    });

    it('should return false for active port even if old', () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const threshold = new Date('2024-01-01T12:00:00Z');

      const portInfo: PortInfo = {
        port: 8080,
        exposedAt: oldDate,
        status: 'active'
      };

      expect(manager.shouldCleanupPort(portInfo, threshold)).toBe(false);
    });

    it('should return false for inactive port newer than threshold', () => {
      const recentDate = new Date('2024-01-01T12:00:01Z');
      const threshold = new Date('2024-01-01T12:00:00Z');

      const portInfo: PortInfo = {
        port: 8080,
        exposedAt: recentDate,
        status: 'inactive'
      };

      expect(manager.shouldCleanupPort(portInfo, threshold)).toBe(false);
    });
  });
});
