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

/**
 * Tests for WebSocket protocol types and utilities.
 *
 * Note: Full WSTransport integration tests require a real WebSocket environment
 * and are covered in E2E tests. These unit tests focus on the protocol layer:
 * message types, type guards, and request ID generation.
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

describe('WebSocket Message Serialization', () => {
  it('should serialize WSRequest correctly', () => {
    const request: WSRequest = {
      type: 'request',
      id: generateRequestId(),
      method: 'POST',
      path: '/api/execute',
      body: { command: 'echo hello', sessionId: 'sess-1' }
    };

    const serialized = JSON.stringify(request);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('request');
    expect(parsed.method).toBe('POST');
    expect(parsed.path).toBe('/api/execute');
    expect(parsed.body.command).toBe('echo hello');
    expect(isWSRequest(parsed)).toBe(true);
  });

  it('should serialize WSResponse correctly', () => {
    const response: WSResponse = {
      type: 'response',
      id: 'req-123',
      status: 200,
      body: {
        success: true,
        stdout: 'hello\n',
        stderr: '',
        exitCode: 0
      },
      done: true
    };

    const serialized = JSON.stringify(response);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('response');
    expect(parsed.status).toBe(200);
    expect(parsed.body.stdout).toBe('hello\n');
    expect(parsed.done).toBe(true);
    expect(isWSResponse(parsed)).toBe(true);
  });

  it('should serialize WSError correctly', () => {
    const error: WSError = {
      type: 'error',
      id: 'req-123',
      code: 'FILE_NOT_FOUND',
      message: 'File not found: /test.txt',
      status: 404,
      context: { path: '/test.txt' }
    };

    const serialized = JSON.stringify(error);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('FILE_NOT_FOUND');
    expect(parsed.status).toBe(404);
    expect(isWSError(parsed)).toBe(true);
  });

  it('should serialize WSStreamChunk correctly', () => {
    const chunk: WSStreamChunk = {
      type: 'stream',
      id: 'req-123',
      event: 'stdout',
      data: 'output line\n'
    };

    const serialized = JSON.stringify(chunk);
    const parsed = JSON.parse(serialized);

    expect(parsed.type).toBe('stream');
    expect(parsed.event).toBe('stdout');
    expect(parsed.data).toBe('output line\n');
    expect(isWSStreamChunk(parsed)).toBe(true);
  });

  it('should handle special characters in body', () => {
    const response: WSResponse = {
      type: 'response',
      id: 'req-123',
      status: 200,
      body: {
        content: 'Line 1\nLine 2\tTabbed\r\nWindows line'
      },
      done: true
    };

    const serialized = JSON.stringify(response);
    const parsed = JSON.parse(serialized);

    expect(parsed.body.content).toBe('Line 1\nLine 2\tTabbed\r\nWindows line');
  });

  it('should handle binary data as base64', () => {
    const binaryData = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64

    const response: WSResponse = {
      type: 'response',
      id: 'req-123',
      status: 200,
      body: {
        content: binaryData,
        encoding: 'base64'
      },
      done: true
    };

    const serialized = JSON.stringify(response);
    const parsed = JSON.parse(serialized);

    expect(parsed.body.content).toBe(binaryData);
    expect(parsed.body.encoding).toBe('base64');
  });

  it('should handle large payloads', () => {
    const largeContent = 'x'.repeat(100000);

    const response: WSResponse = {
      type: 'response',
      id: 'req-123',
      status: 200,
      body: { content: largeContent },
      done: true
    };

    const serialized = JSON.stringify(response);
    const parsed = JSON.parse(serialized);

    expect(parsed.body.content.length).toBe(100000);
  });
});
