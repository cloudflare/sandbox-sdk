import type {
  WSError,
  WSRequest,
  WSResponse,
  WSStreamChunk
} from '@repo/shared';
import {
  generateRequestId,
  isWSError,
  isWSRequest,
  isWSResponse,
  isWSStreamChunk
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { WebSocketTransport } from '../src/clients/transport';

/**
 * Tests for WebSocket protocol types and the WebSocketTransport class.
 *
 * Testing Strategy:
 * - Protocol tests (type guards, serialization): Full unit test coverage here
 * - WebSocketTransport class tests: Limited unit tests for non-connection behavior,
 *   plus comprehensive E2E tests in tests/e2e/websocket-transport.test.ts
 *
 * Why limited WebSocketTransport unit tests:
 * - Tests run in Workers runtime (vitest-pool-workers) where mocking WebSocket
 *   is complex and error-prone
 * - The WebSocketTransport class is tightly coupled to WebSocket - most methods
 *   require an active connection
 * - E2E tests verify the complete request/response cycle, error handling,
 *   streaming, and cleanup against a real container
 */
describe('WebSocket Protocol Types', () => {
  describe('generateRequestId', () => {
    it('should generate unique request IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      const id3 = generateRequestId();

      expect(id1).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^ws_\d+_[a-z0-9]+$/);
      expect(id3).toMatch(/^ws_\d+_[a-z0-9]+$/);

      // All should be unique
      expect(new Set([id1, id2, id3]).size).toBe(3);
    });

    it('should include timestamp in ID', () => {
      const before = Date.now();
      const id = generateRequestId();
      const after = Date.now();

      // Extract timestamp from ID (format: ws_<timestamp>_<random>)
      const parts = id.split('_');
      const timestamp = parseInt(parts[1], 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('isWSRequest', () => {
    it('should return true for valid WSRequest', () => {
      const request: WSRequest = {
        type: 'request',
        id: 'req-123',
        method: 'POST',
        path: '/api/execute',
        body: { command: 'echo hello' }
      };

      expect(isWSRequest(request)).toBe(true);
    });

    it('should return true for minimal WSRequest', () => {
      const request = {
        type: 'request',
        id: 'req-456',
        method: 'GET',
        path: '/api/health'
      };

      expect(isWSRequest(request)).toBe(true);
    });

    it('should return false for non-request types', () => {
      expect(isWSRequest(null)).toBe(false);
      expect(isWSRequest(undefined)).toBe(false);
      expect(isWSRequest('string')).toBe(false);
      expect(isWSRequest({ type: 'response' })).toBe(false);
      expect(isWSRequest({ type: 'error' })).toBe(false);
    });
  });

  describe('isWSResponse', () => {
    it('should return true for valid WSResponse', () => {
      const response: WSResponse = {
        type: 'response',
        id: 'req-123',
        status: 200,
        body: { data: 'test' },
        done: true
      };

      expect(isWSResponse(response)).toBe(true);
    });

    it('should return true for minimal WSResponse', () => {
      const response = {
        type: 'response',
        id: 'req-456',
        status: 404,
        done: false
      };

      expect(isWSResponse(response)).toBe(true);
    });

    it('should return false for non-response types', () => {
      expect(isWSResponse(null)).toBe(false);
      expect(isWSResponse(undefined)).toBe(false);
      expect(isWSResponse('string')).toBe(false);
      expect(isWSResponse({ type: 'error' })).toBe(false);
      expect(isWSResponse({ type: 'stream' })).toBe(false);
      expect(isWSResponse({ type: 'request' })).toBe(false);
    });
  });

  describe('isWSError', () => {
    it('should return true for valid WSError', () => {
      const error: WSError = {
        type: 'error',
        id: 'req-123',
        code: 'NOT_FOUND',
        message: 'Resource not found',
        status: 404
      };

      expect(isWSError(error)).toBe(true);
    });

    it('should return true for WSError without id', () => {
      const error = {
        type: 'error',
        code: 'PARSE_ERROR',
        message: 'Invalid JSON',
        status: 400
      };

      expect(isWSError(error)).toBe(true);
    });

    it('should return false for non-error types', () => {
      expect(isWSError(null)).toBe(false);
      expect(isWSError(undefined)).toBe(false);
      expect(isWSError({ type: 'response' })).toBe(false);
      expect(isWSError({ type: 'stream' })).toBe(false);
    });
  });

  describe('isWSStreamChunk', () => {
    it('should return true for valid WSStreamChunk', () => {
      const chunk: WSStreamChunk = {
        type: 'stream',
        id: 'req-123',
        data: 'chunk data'
      };

      expect(isWSStreamChunk(chunk)).toBe(true);
    });

    it('should return true for WSStreamChunk with event', () => {
      const chunk = {
        type: 'stream',
        id: 'req-456',
        event: 'output',
        data: 'line of output'
      };

      expect(isWSStreamChunk(chunk)).toBe(true);
    });

    it('should return false for non-stream types', () => {
      expect(isWSStreamChunk(null)).toBe(false);
      expect(isWSStreamChunk({ type: 'response' })).toBe(false);
      expect(isWSStreamChunk({ type: 'error' })).toBe(false);
    });
  });
});

describe('WebSocketTransport', () => {
  describe('initial state', () => {
    it('should not be connected after construction', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      expect(transport.isConnected()).toBe(false);
    });

    it('should accept custom options', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws',
        connectTimeoutMs: 5000,
        requestTimeoutMs: 60000
      });
      expect(transport.isConnected()).toBe(false);
    });

    it('should throw if wsUrl is missing', () => {
      expect(() => {
        new WebSocketTransport({});
      }).toThrow('wsUrl is required for WebSocket transport');
    });
  });

  describe('disconnect', () => {
    it('should be safe to call disconnect when not connected', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      // Should not throw
      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });

    it('should be safe to call disconnect multiple times', () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://localhost:3000/ws'
      });
      transport.disconnect();
      transport.disconnect();
      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });
  });

  describe('fetch without connection', () => {
    it('should attempt to connect when making a fetch request', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://invalid-url:9999/ws',
        connectTimeoutMs: 100
      });

      // Fetch should fail because connection fails
      await expect(transport.fetch('/test')).rejects.toThrow();
    });

    it('should attempt to connect when making a stream request', async () => {
      const transport = new WebSocketTransport({
        wsUrl: 'ws://invalid-url:9999/ws',
        connectTimeoutMs: 100
      });

      // Stream request should fail because connection fails
      await expect(transport.fetchStream('/test')).rejects.toThrow();
    });
  });
});
