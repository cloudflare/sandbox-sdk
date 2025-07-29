/**
 * Session Service Tests
 * 
 * Tests the SessionService class from the refactored container architecture.
 * Demonstrates testing services with store abstraction and ServiceResult pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionService, SessionStore } from '@container/services/session-service';
import type { SessionData, Logger } from '@container/core/types';

// Mock the store dependency
const mockSessionStore: SessionStore = {
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn(),
};

const mockLogger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

describe('SessionService', () => {
  let sessionService: SessionService;

  beforeEach(async () => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Clear any intervals/timers
    vi.useFakeTimers();
    
    // Import the SessionService (dynamic import)
    const { SessionService: SessionServiceClass } = await import('@container/services/session-service');
    sessionService = new SessionServiceClass(mockSessionStore, mockLogger);
  });

  afterEach(() => {
    // Clean up timers and destroy service
    sessionService.destroy();
    vi.useRealTimers();
  });

  describe('createSession', () => {
    it('should create session with generated ID and return ServiceResult', async () => {
      const result = await sessionService.createSession();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^session_\d+_[a-f0-9]{12}$/);
        expect(result.data.sessionId).toBe(result.data.id); // backwards compatibility
        expect(result.data.activeProcess).toBeNull();
        expect(result.data.createdAt).toBeInstanceOf(Date);
        expect(result.data.expiresAt).toBeInstanceOf(Date);
      }

      // Verify store was called
      expect(mockSessionStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.stringMatching(/^session_\d+_[a-f0-9]{12}$/),
          activeProcess: null,
          createdAt: expect.any(Date),
          expiresAt: expect.any(Date),
        })
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session created',
        expect.objectContaining({
          sessionId: expect.stringMatching(/^session_\d+_[a-f0-9]{12}$/)
        })
      );
    });

    it('should return error when store creation fails', async () => {
      const storeError = new Error('Store connection failed');
      (mockSessionStore.create as any).mockRejectedValue(storeError);

      const result = await sessionService.createSession();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_CREATE_ERROR');
        expect(result.error.message).toBe('Failed to create session');
        expect(result.error.details?.originalError).toBe('Store connection failed');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to create session',
        storeError
      );
    });

    it('should handle non-Error exceptions in store', async () => {
      (mockSessionStore.create as any).mockRejectedValue('String error');

      const result = await sessionService.createSession();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.details?.originalError).toBe('Unknown error');
      }
    });
  });

  describe('getSession', () => {
    const mockSession: SessionData = {
      id: 'session-123',
      sessionId: 'session-123',
      activeProcess: null,
      createdAt: new Date('2023-01-01T00:00:00Z'),
      expiresAt: new Date('2023-01-01T01:00:00Z'), // 1 hour later
    };

    it('should return session when found and not expired', async () => {
      (mockSessionStore.get as any).mockResolvedValue(mockSession);
      vi.setSystemTime(new Date('2023-01-01T00:30:00Z')); // 30 mins after creation

      const result = await sessionService.getSession('session-123');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(mockSession);
      }

      expect(mockSessionStore.get).toHaveBeenCalledWith('session-123');
    });

    it('should return error when session not found', async () => {
      (mockSessionStore.get as any).mockResolvedValue(null);

      const result = await sessionService.getSession('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
        expect(result.error.message).toBe('Session nonexistent not found');
      }
    });

    it('should delete and return error when session is expired', async () => {
      (mockSessionStore.get as any).mockResolvedValue(mockSession);
      vi.setSystemTime(new Date('2023-01-01T02:00:00Z')); // 2 hours after creation (expired)

      const result = await sessionService.getSession('session-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_EXPIRED');
        expect(result.error.message).toBe('Session session-123 has expired');
      }

      // Verify expired session was deleted
      expect(mockSessionStore.delete).toHaveBeenCalledWith('session-123');
    });

    it('should handle store errors gracefully', async () => {
      const storeError = new Error('Database connection lost');
      (mockSessionStore.get as any).mockRejectedValue(storeError);

      const result = await sessionService.getSession('session-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_GET_ERROR');
        expect(result.error.message).toBe('Failed to get session');
        expect(result.error.details?.sessionId).toBe('session-123');
        expect(result.error.details?.originalError).toBe('Database connection lost');
      }

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get session',
        storeError,
        { sessionId: 'session-123' }
      );
    });
  });

  describe('updateSession', () => {
    it('should update session successfully', async () => {
      const updateData = { activeProcess: 'proc-456' };

      const result = await sessionService.updateSession('session-123', updateData);

      expect(result.success).toBe(true);
      expect(mockSessionStore.update).toHaveBeenCalledWith('session-123', updateData);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session updated',
        { sessionId: 'session-123', updates: ['activeProcess'] }
      );
    });

    it('should handle store update errors', async () => {
      const storeError = new Error('Session not found in store');
      (mockSessionStore.update as any).mockRejectedValue(storeError);

      const result = await sessionService.updateSession('session-123', {});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_UPDATE_ERROR');
        expect(result.error.message).toBe('Failed to update session');
        expect(result.error.details?.sessionId).toBe('session-123');
      }
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully', async () => {
      const result = await sessionService.deleteSession('session-123');

      expect(result.success).toBe(true);
      expect(mockSessionStore.delete).toHaveBeenCalledWith('session-123');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session deleted',
        { sessionId: 'session-123' }
      );
    });

    it('should handle store delete errors', async () => {
      const storeError = new Error('Delete operation failed');
      (mockSessionStore.delete as any).mockRejectedValue(storeError);

      const result = await sessionService.deleteSession('session-123');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_DELETE_ERROR');
        expect(result.error.details?.sessionId).toBe('session-123');
      }
    });
  });

  describe('listSessions', () => {
    it('should return all sessions from store', async () => {
      const mockSessions: SessionData[] = [
        {
          id: 'session-1',
          sessionId: 'session-1',
          activeProcess: null,
          createdAt: new Date(),
          expiresAt: new Date(),
        },
        {
          id: 'session-2',
          sessionId: 'session-2',
          activeProcess: 'proc-123',
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      ];

      (mockSessionStore.list as any).mockResolvedValue(mockSessions);

      const result = await sessionService.listSessions();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(mockSessions);
        expect(result.data).toHaveLength(2);
      }

      expect(mockSessionStore.list).toHaveBeenCalled();
    });

    it('should handle store list errors', async () => {
      const storeError = new Error('Store list failed');
      (mockSessionStore.list as any).mockRejectedValue(storeError);

      const result = await sessionService.listSessions();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_LIST_ERROR');
      }
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should cleanup expired sessions and return count', async () => {
      (mockSessionStore.cleanup as any).mockResolvedValue(3);

      const result = await sessionService.cleanupExpiredSessions();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(3);
      }

      // Verify cleanup was called with 1 hour ago threshold
      expect(mockSessionStore.cleanup).toHaveBeenCalledWith(
        expect.any(Date)
      );

      // Verify logging when sessions were cleaned
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleaned up expired sessions',
        { count: 3 }
      );
    });

    it('should not log when no sessions are cleaned', async () => {
      (mockSessionStore.cleanup as any).mockResolvedValue(0);

      const result = await sessionService.cleanupExpiredSessions();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(0);
      }

      // Should not log when count is 0
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        'Cleaned up expired sessions',
        expect.any(Object)
      );
    });

    it('should handle cleanup errors', async () => {
      const cleanupError = new Error('Cleanup failed');
      (mockSessionStore.cleanup as any).mockRejectedValue(cleanupError);

      const result = await sessionService.cleanupExpiredSessions();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('SESSION_CLEANUP_ERROR');
      }
    });
  });

  describe('lifecycle management', () => {
    it('should start cleanup interval on construction', () => {
      // Verify that setInterval was called (constructor starts cleanup process)
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    });

    it('should cleanup interval on destroy', () => {
      const initialTimerCount = vi.getTimerCount();
      
      sessionService.destroy();
      
      // Should have fewer timers after destroy
      expect(vi.getTimerCount()).toBeLessThan(initialTimerCount);
    });

    it('should run automatic cleanup every 10 minutes', async () => {
      (mockSessionStore.cleanup as any).mockResolvedValue(2);

      // Fast-forward 10 minutes
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      // Verify cleanup was called
      expect(mockSessionStore.cleanup).toHaveBeenCalled();
    });
  });
});

/**
 * This test demonstrates several key patterns for testing services in the new architecture:
 * 
 * 1. **Store Abstraction Testing**: SessionService uses an injected SessionStore,
 *    making it trivial to mock the persistence layer.
 * 
 * 2. **ServiceResult Pattern Validation**: All methods return ServiceResult<T>,
 *    enabling consistent testing of both success and error scenarios.
 * 
 * 3. **Timer/Lifecycle Testing**: The service manages cleanup intervals, and we
 *    test this using Vitest's fake timers.
 * 
 * 4. **Comprehensive Error Scenarios**: Tests cover store failures, not found cases,
 *    expired sessions, and different error conditions.
 * 
 * 5. **Logging Verification**: Validates that appropriate log messages are generated
 *    for different scenarios.
 * 
 * 6. **Edge Case Coverage**: Tests handle non-Error exceptions, zero cleanup counts,
 *    and proper resource cleanup.
 */