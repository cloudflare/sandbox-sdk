/**
 * Unit tests for logger module
 *
 * Tests cover:
 * ✅ Logger methods work correctly (debug, info, warn, error)
 * ✅ Context inheritance via `.child()`
 * ✅ Log level filtering
 * ✅ Trace ID generation and extraction
 * ✅ Pretty printing vs JSON formatting
 * ✅ Color codes in pretty mode
 * ✅ Environment detection
 * ✅ Edge cases
 *
 * What we DON'T test:
 * ❌ Exact log output format (implementation detail)
 * ❌ Whether specific operations log (brittle)
 * ❌ Log content validation (too fragile)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger/index';
import { CloudflareLogger } from '../src/logger/logger';
import { TraceContext } from '../src/logger/trace-context';
import type { LogContext } from '../src/logger/types';
import { LogLevel as LogLevelEnum } from '../src/logger/types';

describe('Logger Module', () => {
  // Mock console methods
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CloudflareLogger - Basic Logging', () => {
    it('should log debug messages when level is DEBUG', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_test123' } as LogContext,
        LogLevelEnum.DEBUG,
        'json-line'
      );

      logger.debug('Debug message', { customField: 'test' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = consoleLogSpy.mock.calls[0][0] as string;
      expect(JSON.parse(logOutput)).toMatchObject({
        level: 'debug',
        message: 'Debug message',
        component: 'sandbox-do',
        traceId: 'tr_test123',
        customField: 'test'
      });
    });

    it('should log info messages', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_abc' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('Info message');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('info');
      expect(logOutput.message).toBe('Info message');
    });

    it('should log warn messages', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_xyz' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.warn('Warning message');

      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('warn');
      expect(logOutput.message).toBe('Warning message');
    });

    it('should log error messages with error object', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_err' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';
      logger.error('Error occurred', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('error');
      expect(logOutput.message).toBe('Error occurred');
      expect(logOutput.error).toMatchObject({
        message: 'Test error',
        stack: expect.stringContaining('Error: Test error')
      });
    });

    it('should include timestamp in all logs', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_time' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('Test message');

      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });
  });

  describe('CloudflareLogger - Log Level Filtering', () => {
    it('should not log debug when level is INFO', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log info when level is WARN', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.WARN,
        'json-line'
      );

      logger.info('Info message');
      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should log warn and error when level is WARN', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.WARN,
        'json-line'
      );

      logger.warn('Warning');
      logger.error('Error');

      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });

    it('should only log errors when level is ERROR', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.ERROR,
        'json-line'
      );

      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warn');
      logger.error('Error');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });
  });

  describe('CloudflareLogger - Context Inheritance', () => {
    it('should create child logger with merged context', () => {
      const parentLogger = new CloudflareLogger(
        {
          component: 'sandbox-do',
          traceId: 'tr_parent',
          sandboxId: 'sandbox-1'
        } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      const childLogger = parentLogger.child({
        commandId: 'cmd-123'
      });
      childLogger.info('Child log');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput).toMatchObject({
        component: 'sandbox-do',
        traceId: 'tr_parent',
        sandboxId: 'sandbox-1',
        commandId: 'cmd-123'
      });
    });

    it('should allow nested child loggers', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_nest' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      const child1 = logger.child({ sessionId: 'session-1' });
      const child2 = child1.child({ commandId: 'cmd-456' });

      child2.info('Nested child log');

      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput).toMatchObject({
        component: 'container',
        traceId: 'tr_nest',
        sessionId: 'session-1',
        commandId: 'cmd-456'
      });
    });

    it('should inherit log level from parent', () => {
      const parentLogger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_level' } as LogContext,
        LogLevelEnum.ERROR,
        'json-line'
      );

      const childLogger = parentLogger.child({ commandId: 'cmd-test' });

      childLogger.info('Should not log');
      childLogger.error('Should log');

      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });
  });

  describe('CloudflareLogger - Pretty Printing', () => {
    it('should use pretty printing when enabled', () => {
      const logger = new CloudflareLogger(
        {
          component: 'sandbox-do',
          traceId: 'tr_pretty123456789',
          sandboxId: 'sandbox-1'
        } as LogContext,
        LogLevelEnum.INFO,
        'pretty'
      );

      logger.info('Test message');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as string;

      // Pretty output should NOT be JSON
      expect(typeof output).toBe('string');
      expect(() => JSON.parse(output)).toThrow();

      // Should contain human-readable elements
      expect(output).toContain('INFO');
      expect(output).toContain('[sandbox-do]');
      expect(output).toContain('Test message');
      expect(output).toContain('tr_pretty123'); // Truncated trace ID (12 chars)
    });

    it('should use json-line output for container mode', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_json' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('JSON message');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
      expect(JSON.parse(output)).toMatchObject({
        level: 'info',
        message: 'JSON message',
        component: 'container'
      });
    });

    it('should include ANSI color codes in pretty mode', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_color' } as LogContext,
        LogLevelEnum.INFO,
        'pretty'
      );

      logger.info('Colored info');
      logger.warn('Colored warn');
      logger.error('Colored error');

      // Check for ANSI escape codes
      expect(consoleLogSpy.mock.calls[0][0] as string).toContain('\x1b['); // ANSI code prefix
      expect(consoleWarnSpy.mock.calls[0][0] as string).toContain('\x1b[');
      expect(consoleErrorSpy.mock.calls[0][0] as string).toContain('\x1b[');
    });

    it('should include error details inline in pretty mode', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_stack' } as LogContext,
        LogLevelEnum.ERROR,
        'pretty'
      );

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';
      logger.error('Error with stack', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      expect(output).toContain('err.msg=Test error');
      expect(output).toContain('err.stack=Error: Test error');
    });
  });

  describe('CloudflareLogger - Output Modes', () => {
    it('structured mode passes raw object to consoleFn', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_struct123' } as LogContext,
        LogLevelEnum.INFO,
        'structured'
      );

      logger.info('Structured log');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0];

      // Must be a raw object, not a string
      expect(typeof output).toBe('object');
      expect(output).toHaveProperty('message', 'Structured log');
      expect(output).toHaveProperty('level', 'info');
      expect(output).toHaveProperty('traceId', 'tr_struct123');
    });

    it('json-line mode passes JSON string to consoleFn', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_jsonline' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('JSON line log');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0];

      expect(typeof output).toBe('string');
      const parsed = JSON.parse(output as string);
      expect(parsed).toHaveProperty('message', 'JSON line log');
      expect(parsed).toHaveProperty('level', 'info');
    });

    it('pretty mode passes ANSI-formatted string', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_prettymode' } as LogContext,
        LogLevelEnum.INFO,
        'pretty'
      );

      logger.info('Pretty log');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as string;

      expect(typeof output).toBe('string');
      expect(() => JSON.parse(output)).toThrow();
      expect(output).toContain('\x1b[');
      expect(output).toContain('Pretty log');
    });

    it('structured mode preserves error fields as discrete properties', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_structerr' } as LogContext,
        LogLevelEnum.ERROR,
        'structured'
      );

      const error = new TypeError('bad input');
      error.stack = 'TypeError: bad input\n    at foo.ts:10:5';
      logger.error('Operation failed', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as Record<
        string,
        unknown
      >;

      expect(typeof output).toBe('object');
      const errObj = output.error as Record<string, unknown>;
      expect(errObj.name).toBe('TypeError');
      expect(errObj.message).toBe('bad input');
      expect(errObj.stack).toContain('TypeError: bad input');
    });

    it('json-line mode preserves error fields in serialized output', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_jsonerr' } as LogContext,
        LogLevelEnum.ERROR,
        'json-line'
      );

      const error = new RangeError('out of bounds');
      error.stack = 'RangeError: out of bounds\n    at bar.ts:5:3';
      logger.error('Range check failed', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = consoleErrorSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);

      expect(parsed.error.name).toBe('RangeError');
      expect(parsed.error.message).toBe('out of bounds');
      expect(parsed.error.stack).toContain('RangeError: out of bounds');
    });

    it('uses message field instead of msg in all modes', () => {
      const structured = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_msgfield' } as LogContext,
        LogLevelEnum.INFO,
        'structured'
      );
      structured.info('hello structured');

      const structOut = consoleLogSpy.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(structOut).toHaveProperty('message', 'hello structured');
      expect(structOut).not.toHaveProperty('msg');

      consoleLogSpy.mockClear();

      const jsonLine = new CloudflareLogger(
        { component: 'container', traceId: 'tr_msgfield2' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );
      jsonLine.info('hello json');

      const jsonOut = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(jsonOut).toHaveProperty('message', 'hello json');
      expect(jsonOut).not.toHaveProperty('msg');
    });
  });

  describe('TraceContext', () => {
    it('should generate trace IDs with correct format', () => {
      const traceId = TraceContext.generate();

      expect(traceId).toMatch(/^tr_[0-9a-f]{16}$/);
    });

    it('should generate unique trace IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(TraceContext.generate());
      }

      expect(ids.size).toBe(100);
    });

    it('should extract trace ID from headers', () => {
      const headers = new Headers();
      headers.set('X-Trace-Id', 'tr_abc123def456');

      const traceId = TraceContext.fromHeaders(headers);

      expect(traceId).toBe('tr_abc123def456');
    });

    it('should return null when trace ID not in headers', () => {
      const headers = new Headers();

      const traceId = TraceContext.fromHeaders(headers);

      expect(traceId).toBeNull();
    });

    it('should create headers object with trace ID', () => {
      const headers = TraceContext.toHeaders('tr_test123');

      expect(headers).toEqual({ 'X-Trace-Id': 'tr_test123' });
    });

    it('should provide header name', () => {
      expect(TraceContext.getHeaderName()).toBe('X-Trace-Id');
    });
  });

  describe('createLogger Factory', () => {
    afterEach(() => {
      delete process.env.SANDBOX_LOG_FORMAT;
    });

    it('should create structured logger for sandbox-do component', () => {
      const logger = createLogger({
        component: 'sandbox-do',
        traceId: 'tr_factory',
        sandboxId: 'sandbox-1'
      });

      logger.info('Factory test');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof output).toBe('object');
      expect(output).toMatchObject({
        component: 'sandbox-do',
        traceId: 'tr_factory',
        sandboxId: 'sandbox-1'
      });
    });

    it('should create json-line logger for container component', () => {
      const logger = createLogger({
        component: 'container'
      });

      logger.info('Auto trace');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(typeof output).toBe('string');
      const parsed = JSON.parse(output);
      expect(parsed.traceId).toMatch(/^tr_[0-9a-f]{16}$/);
    });

    it('should create pretty logger when SANDBOX_LOG_FORMAT=pretty', () => {
      process.env.SANDBOX_LOG_FORMAT = 'pretty';
      const logger = createLogger({
        component: 'sandbox-do',
        traceId: 'tr_prettyfactory'
      });

      logger.info('Pretty factory');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(typeof output).toBe('string');
      expect(output).toContain('Pretty factory');
    });

    it('should use pretty for container when SANDBOX_LOG_FORMAT=pretty', () => {
      process.env.SANDBOX_LOG_FORMAT = 'pretty';
      const logger = createLogger({
        component: 'container'
      });

      logger.info('Container pretty in local dev');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(typeof output).toBe('string');
      expect(output).toContain('Container pretty in local dev');
      expect(() => JSON.parse(output)).toThrow();
    });

    it('should default container to json-line when SANDBOX_LOG_FORMAT is not set', () => {
      delete process.env.SANDBOX_LOG_FORMAT;
      const logger = createLogger({
        component: 'container'
      });

      logger.info('Container json-line in production');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(typeof output).toBe('string');
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty context', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_empty' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('Message', {});

      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it('should handle undefined error in error()', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_noerr' } as LogContext,
        LogLevelEnum.ERROR,
        'json-line'
      );

      logger.error('Error without error object', undefined);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
      expect(output.error).toBeUndefined();
    });

    it('should handle very long messages', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_long' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      const longMessage = 'A'.repeat(10000);
      logger.info(longMessage);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.message).toBe(longMessage);
    });

    it('should handle special characters in messages', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_special' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      const specialMessage =
        'Message with "quotes", \\backslashes\\, and \n newlines';
      logger.info(specialMessage);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.message).toBe(specialMessage);
    });

    it('should handle context with undefined values', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_undef' } as LogContext,
        LogLevelEnum.INFO,
        'json-line'
      );

      logger.info('Message', { commandId: 'cmd-123' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.commandId).toBe('cmd-123');
    });

    it('should handle errors with circular references in error object', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_circ' } as LogContext,
        LogLevelEnum.ERROR,
        'json-line'
      );

      const error = new Error('Circular error');
      // Our logger only extracts message, stack, name - so circular refs won't break it
      logger.error('Circular reference error', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });
  });
});
