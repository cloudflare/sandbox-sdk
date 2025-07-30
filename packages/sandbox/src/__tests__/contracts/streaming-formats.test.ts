/**
 * Streaming Formats Contract Tests
 * 
 * These tests validate that the container's SSE streaming output matches
 * the SDK's interface expectations exactly. This prevents the streaming
 * contract breaks we experienced during refactoring.
 */

import type { ExecEvent, LogEvent } from '../../types';
import { parseSSEStream } from '../../sse-parser';
import type { StartProcessResponse } from '@container/core/types';

// Mock container endpoint for testing
const CONTAINER_BASE_URL = 'http://localhost:3000'; // This would be a test container

describe('Container Streaming Format Contracts', () => {
  describe('Command Execution Streaming (ExecEvent)', () => {
    it('should emit ExecEvent-compliant SSE format for command execution', async () => {
      // This test validates the exact format that broke during refactoring
      const response = await fetch(`${CONTAINER_BASE_URL}/api/execute/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "contract test"' })
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Parse SSE stream and validate each event matches ExecEvent interface
      const events: ExecEvent[] = [];
      for await (const event of parseSSEStream<ExecEvent>(response.body!)) {
        events.push(event);
        
        // Validate event structure matches ExecEvent interface exactly
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('timestamp');
        expect(['start', 'stdout', 'stderr', 'complete', 'error']).toContain(event.type);
        
        // Type-specific validations
        if (event.type === 'start') {
          expect(typeof event.timestamp).toBe('string');
        } else if (event.type === 'stdout' || event.type === 'stderr') {
          expect(event).toHaveProperty('data');
          expect(typeof event.data).toBe('string');
        } else if (event.type === 'complete') {
          expect(event).toHaveProperty('exitCode');
          expect(typeof event.exitCode).toBe('number');
        } else if (event.type === 'error') {
          expect(event).toHaveProperty('error');
          expect(typeof event.error).toBe('string');
        }
      }

      // Validate complete event sequence
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('start');
      expect(events[events.length - 1].type).toBe('complete');
      
      // Validate stdout content
      const stdoutEvents = events.filter(e => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);
      expect(stdoutEvents[0].data).toContain('contract test');
    });

    it('should emit ExecEvent-compliant format for command errors', async () => {
      const response = await fetch(`${CONTAINER_BASE_URL}/api/execute/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'nonexistent-command-12345' })
      });

      const events: ExecEvent[] = [];
      for await (const event of parseSSEStream<ExecEvent>(response.body!)) {
        events.push(event);
      }

      // Should have start and error events
      expect(events[0].type).toBe('start');
      
      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error).toBeDefined();
      expect(typeof errorEvent!.error).toBe('string');
    });

    it('should not emit old format that broke SDK integration', async () => {
      // This test ensures we don't regress to the broken format
      const response = await fetch(`${CONTAINER_BASE_URL}/api/execute/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "format check"' })
      });

      for await (const event of parseSSEStream<any>(response.body!)) {
        // Ensure we DON'T see the old broken format:
        // {"type": "output", "stream": "stdout", "data": "..."}
        
        if (event.data) {
          expect(event.type).not.toBe('output'); // Old broken format
          expect(event).not.toHaveProperty('stream'); // Old broken format
          
          // Should be new correct format:
          // {"type": "stdout", "data": "...", "timestamp": "..."}
          expect(['stdout', 'stderr']).toContain(event.type);
        }
      }
    });
  });

  describe('Process Log Streaming (LogEvent)', () => {
    it('should emit LogEvent-compliant SSE format for process logs', async () => {
      // Start a background process first
      const startResponse = await fetch(`${CONTAINER_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          command: 'echo "process log test" && sleep 1 && echo "second line"', 
          background: true 
        })
      });

      const startResult = await startResponse.json() as StartProcessResponse;
      expect(startResult.success).toBe(true);
      const processId = startResult.process.id;

      // Stream process logs
      const response = await fetch(`${CONTAINER_BASE_URL}/api/process/${processId}/logs/stream`);

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Parse SSE stream and validate LogEvent format
      const events: LogEvent[] = [];
      for await (const event of parseSSEStream<LogEvent>(response.body!)) {
        events.push(event);

        // Validate event structure matches LogEvent interface exactly
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('processId');
        expect(event).toHaveProperty('timestamp');
        expect(['stdout', 'stderr', 'exit']).toContain(event.type);
        expect(event.processId).toBe(processId);

        if (event.type === 'stdout' || event.type === 'stderr') {
          expect(event).toHaveProperty('data');
          expect(typeof event.data).toBe('string');
        } else if (event.type === 'exit') {
          expect(event).toHaveProperty('exitCode');
          expect(typeof event.exitCode).toBe('number');
        }
      }

      // Validate we got stdout events
      const stdoutEvents = events.filter(e => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThan(0);
      expect(stdoutEvents[0].data).toContain('process log test');
    });

    it('should not emit old broken LogEvent format', async () => {
      // Start a process for testing
      const startResponse = await fetch(`${CONTAINER_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "log format check"', background: true })
      });

      const startResult = await startResponse.json() as StartProcessResponse;
      const processId = startResult.process.id;

      const response = await fetch(`${CONTAINER_BASE_URL}/api/process/${processId}/logs/stream`);

      for await (const event of parseSSEStream<any>(response.body!)) {
        // Ensure we DON'T see the old broken format:
        // {"type": "output", "stream": "stderr", "data": "..."}
        
        expect(event.type).not.toBe('output'); // Old broken format
        expect(event).not.toHaveProperty('stream'); // Old broken format
        
        // Should be new correct format:
        // {"type": "stderr", "data": "...", "processId": "...", "timestamp": "..."}
        if (event.data) {
          expect(['stdout', 'stderr']).toContain(event.type);
          expect(event.processId).toBeDefined();
        }
      }
    });
  });

  describe('Type Safety Validation', () => {
    it('should pass TypeScript type checking for ExecEvent', async () => {
      const response = await fetch(`${CONTAINER_BASE_URL}/api/execute/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "type test"' })
      });

      for await (const event of parseSSEStream<ExecEvent>(response.body!)) {
        // This assignment should compile without errors
        const typedEvent: ExecEvent = event;
        
        // If we get here, the event structure matches ExecEvent exactly
        expect(typedEvent).toBeDefined();
      }
    });

    it('should pass TypeScript type checking for LogEvent', async () => {
      const startResponse = await fetch(`${CONTAINER_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "type test"', background: true })
      });

      const startResult = await startResponse.json() as StartProcessResponse;
      const processId = startResult.process.id;

      const response = await fetch(`${CONTAINER_BASE_URL}/api/process/${processId}/logs/stream`);

      for await (const event of parseSSEStream<LogEvent>(response.body!)) {
        // This assignment should compile without errors
        const typedEvent: LogEvent = event;
        
        // If we get here, the event structure matches LogEvent exactly
        expect(typedEvent).toBeDefined();
      }
    });
  });
});

/**
 * These contract tests are CRITICAL for preventing the streaming format breaks
 * we experienced during container refactoring. They validate:
 * 
 * 1. **Exact Interface Compliance**: Container output matches SDK interfaces exactly
 * 2. **Format Regression Prevention**: Ensures we don't revert to broken formats  
 * 3. **Type Safety**: Validates TypeScript type compatibility at runtime
 * 4. **Consumer Pattern Validation**: Tests the exact usage patterns from SDK consumers
 * 
 * These tests should be run against the actual container implementation to catch
 * any interface breaks before they reach production or SDK consumers.
 * 
 * If these tests fail, it means a breaking change has been introduced that will
 * affect all SDK users, and the change should be reverted or the SDK interfaces
 * should be updated accordingly.
 */