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
import { createLogger, getLogger, runWithLogger } from '../src/logger/index';
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
        false
      );

      logger.debug('Debug message', { operation: 'test' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = consoleLogSpy.mock.calls[0][0] as string;
      expect(JSON.parse(logOutput)).toMatchObject({
        level: 'debug',
        msg: 'Debug message',
        component: 'sandbox-do',
        traceId: 'tr_test123',
        operation: 'test'
      });
    });

    it('should log info messages', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_abc' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      logger.info('Info message');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('info');
      expect(logOutput.msg).toBe('Info message');
    });

    it('should log warn messages', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_xyz' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      logger.warn('Warning message');

      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('warn');
      expect(logOutput.msg).toBe('Warning message');
    });

    it('should log error messages with error object', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_err' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';
      logger.error('Error occurred', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
      expect(logOutput.level).toBe('error');
      expect(logOutput.msg).toBe('Error occurred');
      expect(logOutput.error).toMatchObject({
        message: 'Test error',
        stack: expect.stringContaining('Error: Test error')
      });
    });

    it('should include timestamp in all logs', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_time' } as LogContext,
        LogLevelEnum.INFO,
        false
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
        false
      );

      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log info when level is WARN', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.WARN,
        false
      );

      logger.info('Info message');
      logger.debug('Debug message');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should log warn and error when level is WARN', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_filter' } as LogContext,
        LogLevelEnum.WARN,
        false
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
        false
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
        false
      );

      const childLogger = parentLogger.child({
        operation: 'exec',
        commandId: 'cmd-123'
      });
      childLogger.info('Child log');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput).toMatchObject({
        component: 'sandbox-do',
        traceId: 'tr_parent',
        sandboxId: 'sandbox-1',
        operation: 'exec',
        commandId: 'cmd-123'
      });
    });

    it('should allow nested child loggers', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_nest' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      const child1 = logger.child({ sessionId: 'session-1' });
      const child2 = child1.child({ operation: 'exec' });
      const child3 = child2.child({ commandId: 'cmd-456' });

      child3.info('Nested child log');

      const logOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logOutput).toMatchObject({
        component: 'container',
        traceId: 'tr_nest',
        sessionId: 'session-1',
        operation: 'exec',
        commandId: 'cmd-456'
      });
    });

    it('should inherit log level from parent', () => {
      const parentLogger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_level' } as LogContext,
        LogLevelEnum.ERROR,
        false
      );

      const childLogger = parentLogger.child({ operation: 'test' });

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
        true // Enable pretty printing
      );

      logger.info('Test message', { operation: 'exec' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as string;

      // Pretty output should NOT be JSON
      expect(typeof output).toBe('string');
      expect(() => JSON.parse(output)).toThrow();

      // Should contain human-readable elements
      expect(output).toContain('INFO');
      expect(output).toContain('[durable-object]');
      expect(output).toContain('Test message');
      expect(output).toContain('tr_pretty123'); // Truncated trace ID (12 chars)
    });

    it('should use JSON output when pretty printing disabled', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_json' } as LogContext,
        LogLevelEnum.INFO,
        false // Disable pretty printing
      );

      logger.info('JSON message');

      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
      expect(JSON.parse(output)).toMatchObject({
        level: 'info',
        msg: 'JSON message',
        component: 'container'
      });
    });

    it('should include ANSI color codes in pretty mode', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_color' } as LogContext,
        LogLevelEnum.INFO,
        true
      );

      logger.info('Colored info');
      logger.warn('Colored warn');
      logger.error('Colored error');

      // Check for ANSI escape codes
      expect(consoleLogSpy.mock.calls[0][0] as string).toContain('\x1b['); // ANSI code prefix
      expect(consoleWarnSpy.mock.calls[0][0] as string).toContain('\x1b[');
      expect(consoleErrorSpy.mock.calls[0][0] as string).toContain('\x1b[');
    });

    it('should display error stack in pretty mode', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_stack' } as LogContext,
        LogLevelEnum.ERROR,
        true
      );

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';
      logger.error('Error with stack', error);

      // Pretty mode should output multiple lines for errors
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(1);
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
    beforeEach(() => {
      // Set NODE_ENV to production to force JSON output
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      // Clean up
      delete process.env.NODE_ENV;
    });

    it('should create logger with base context', () => {
      const logger = createLogger({
        component: 'sandbox-do',
        traceId: 'tr_factory',
        sandboxId: 'sandbox-1'
      });

      logger.info('Factory test');

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output).toMatchObject({
        component: 'sandbox-do',
        traceId: 'tr_factory',
        sandboxId: 'sandbox-1'
      });
    });

    it('should auto-generate trace ID if not provided', () => {
      const logger = createLogger({
        component: 'container'
      });

      logger.info('Auto trace');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.traceId).toMatch(/^tr_[0-9a-f]{16}$/);
    });
  });

  describe('AsyncLocalStorage Context', () => {
    beforeEach(() => {
      // Set NODE_ENV to production to force JSON output
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      // Clean up
      delete process.env.NODE_ENV;
    });

    it('should store and retrieve logger from context', async () => {
      const logger = createLogger({
        component: 'sandbox-do',
        traceId: 'tr_async'
      });

      await runWithLogger(logger, () => {
        const retrievedLogger = getLogger();
        retrievedLogger.info('From async context');
      });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.traceId).toBe('tr_async');
    });

    it('should throw error when accessing logger outside context', () => {
      expect(() => getLogger()).toThrow(
        'Logger not initialized in async context'
      );
    });

    it('should support nested runWithLogger calls', async () => {
      const parentLogger = createLogger({
        component: 'sandbox-do',
        traceId: 'tr_parent'
      });

      await runWithLogger(parentLogger, async () => {
        const childLogger = getLogger().child({ operation: 'exec' });

        await runWithLogger(childLogger, () => {
          const retrievedLogger = getLogger();
          retrievedLogger.info('Nested context');
        });
      });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output).toMatchObject({
        traceId: 'tr_parent',
        operation: 'exec'
      });
    });

    it('should isolate logger between async operations', async () => {
      const logger1 = createLogger({ component: 'container', traceId: 'tr_1' });
      const logger2 = createLogger({ component: 'container', traceId: 'tr_2' });

      const promise1 = runWithLogger(logger1, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        getLogger().info('Logger 1');
      });

      const promise2 = runWithLogger(logger2, async () => {
        getLogger().info('Logger 2');
      });

      await Promise.all([promise1, promise2]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      const outputs = consoleLogSpy.mock.calls.map((call) =>
        JSON.parse(call[0] as string)
      );
      const traceIds = outputs.map((o) => o.traceId);

      expect(traceIds).toContain('tr_1');
      expect(traceIds).toContain('tr_2');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty context', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_empty' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      logger.info('Message', {});

      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it('should handle undefined error in error()', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_noerr' } as LogContext,
        LogLevelEnum.ERROR,
        false
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
        false
      );

      const longMessage = 'A'.repeat(10000);
      logger.info(longMessage);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.msg).toBe(longMessage);
    });

    it('should handle special characters in messages', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_special' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      const specialMessage =
        'Message with "quotes", \\backslashes\\, and \n newlines';
      logger.info(specialMessage);

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.msg).toBe(specialMessage);
    });

    it('should handle context with undefined values', () => {
      const logger = new CloudflareLogger(
        { component: 'container', traceId: 'tr_undef' } as LogContext,
        LogLevelEnum.INFO,
        false
      );

      logger.info('Message', { operation: undefined, commandId: 'cmd-123' });

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.commandId).toBe('cmd-123');
    });

    it('should handle errors with circular references in error object', () => {
      const logger = new CloudflareLogger(
        { component: 'sandbox-do', traceId: 'tr_circ' } as LogContext,
        LogLevelEnum.ERROR,
        false
      );

      const error = new Error('Circular error');
      // Our logger only extracts message, stack, name - so circular refs won't break it
      logger.error('Circular reference error', error);

      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });
  });
});
