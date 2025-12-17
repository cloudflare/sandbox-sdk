import {
  type CodeContext,
  type ContextCreateResult,
  type ContextListResult,
  type CreateContextOptions,
  type ExecutionError,
  type OutputMessage,
  type Result,
  ResultImpl
} from '@repo/shared';
import type { ErrorResponse } from '../errors';
import {
  createErrorFromResponse,
  ErrorCode,
  InterpreterNotReadyError
} from '../errors';
import { BaseHttpClient } from './base-client.js';
import type { HttpClientOptions } from './types.js';

// Streaming execution data from the server
interface StreamingExecutionData {
  type: 'result' | 'stdout' | 'stderr' | 'error' | 'execution_complete';
  text?: string;
  html?: string;
  png?: string; // base64
  jpeg?: string; // base64
  svg?: string;
  latex?: string;
  markdown?: string;
  javascript?: string;
  json?: unknown;
  chart?: {
    type:
      | 'line'
      | 'bar'
      | 'scatter'
      | 'pie'
      | 'histogram'
      | 'heatmap'
      | 'unknown';
    data: unknown;
    options?: unknown;
  };
  data?: unknown;
  metadata?: Record<string, unknown>;
  execution_count?: number;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  lineNumber?: number;
  timestamp?: number;
}

export interface ExecutionCallbacks {
  onStdout?: (output: OutputMessage) => void | Promise<void>;
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}

export class InterpreterClient extends BaseHttpClient {
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  async createCodeContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch('/api/contexts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: options.language || 'python',
          cwd: options.cwd || '/workspace',
          env_vars: options.envVars
        })
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      const data = (await response.json()) as ContextCreateResult;
      if (!data.success) {
        throw new Error(`Failed to create context: ${JSON.stringify(data)}`);
      }

      return {
        id: data.contextId,
        language: data.language,
        cwd: data.cwd || '/workspace',
        createdAt: new Date(data.timestamp),
        lastUsed: new Date(data.timestamp)
      };
    });
  }

  async runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: ExecutionCallbacks,
    timeoutMs?: number
  ): Promise<void> {
    return this.executeWithRetry(async () => {
      // Use doStreamFetch which handles both WebSocket and HTTP streaming
      const stream = await this.doStreamFetch('/api/execute/code', {
        context_id: contextId,
        code,
        language,
        ...(timeoutMs !== undefined && { timeout_ms: timeoutMs })
      });

      // Process streaming response
      for await (const chunk of this.readLines(stream)) {
        await this.parseExecutionResult(chunk, callbacks);
      }
    });
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch('/api/contexts', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      const data = (await response.json()) as ContextListResult;
      if (!data.success) {
        throw new Error(`Failed to list contexts: ${JSON.stringify(data)}`);
      }

      return data.contexts.map((ctx) => ({
        id: ctx.id,
        language: ctx.language,
        cwd: ctx.cwd || '/workspace',
        createdAt: new Date(data.timestamp),
        lastUsed: new Date(data.timestamp)
      }));
    });
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch(`/api/contexts/${contextId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }
    });
  }

  /**
   * Get a raw stream for code execution.
   * Used by CodeInterpreter.runCodeStreaming() for direct stream access.
   */
  async streamCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<ReadableStream<Uint8Array>> {
    return this.doStreamFetch('/api/execute/code', {
      context_id: contextId,
      code,
      language
    });
  }

  /**
   * Execute an operation with automatic retry for transient errors
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        this.logError('executeWithRetry', error);
        lastError = error as Error;

        // Check if it's a retryable error (interpreter not ready)
        if (this.isRetryableError(error)) {
          // Don't retry on the last attempt
          if (attempt < this.maxRetries - 1) {
            // Exponential backoff with jitter
            const delay =
              this.retryDelayMs * 2 ** attempt + Math.random() * 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // Not retryable or last attempt - throw the error
        throw error;
      }
    }

    throw lastError || new Error('Execution failed after retries');
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof InterpreterNotReadyError) {
      return true;
    }

    if (error instanceof Error) {
      return (
        error.message.includes('not ready') ||
        error.message.includes('initializing')
      );
    }

    return false;
  }

  private async parseErrorResponse(response: Response): Promise<Error> {
    try {
      const errorData = (await response.json()) as ErrorResponse;
      return createErrorFromResponse(errorData);
    } catch {
      // Fallback if response isn't JSON
      const errorResponse: ErrorResponse = {
        code: ErrorCode.INTERNAL_ERROR,
        message: `HTTP ${response.status}: ${response.statusText}`,
        context: {},
        httpStatus: response.status,
        timestamp: new Date().toISOString()
      };
      return createErrorFromResponse(errorResponse);
    }
  }

  private async *readLines(
    stream: ReadableStream<Uint8Array>
  ): AsyncGenerator<string> {
    const reader = stream.getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += new TextDecoder().decode(value);
        }
        if (done) break;

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          yield buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf('\n');
        }
      }

      // Yield any remaining data
      if (buffer.length > 0) {
        yield buffer;
      }
    } finally {
      // Cancel the stream first to properly terminate HTTP connections when breaking early
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors (stream may already be closed)
      }
      reader.releaseLock();
    }
  }

  private async parseExecutionResult(
    line: string,
    callbacks: ExecutionCallbacks
  ) {
    if (!line.trim()) return;

    // Skip lines that don't start with "data: " (SSE format)
    if (!line.startsWith('data: ')) return;

    try {
      // Strip "data: " prefix and parse JSON
      const jsonData = line.substring(6); // "data: " is 6 characters
      const data = JSON.parse(jsonData) as StreamingExecutionData;

      switch (data.type) {
        case 'stdout':
          if (callbacks.onStdout && data.text) {
            await callbacks.onStdout({
              text: data.text,
              timestamp: data.timestamp || Date.now()
            });
          }
          break;

        case 'stderr':
          if (callbacks.onStderr && data.text) {
            await callbacks.onStderr({
              text: data.text,
              timestamp: data.timestamp || Date.now()
            });
          }
          break;

        case 'result':
          if (callbacks.onResult) {
            // Create a ResultImpl instance from the raw data
            const result = new ResultImpl(data);
            await callbacks.onResult(result);
          }
          break;

        case 'error':
          if (callbacks.onError) {
            await callbacks.onError({
              name: data.ename || 'Error',
              message: data.evalue || 'Unknown error',
              traceback: data.traceback || []
            });
          }
          break;

        case 'execution_complete':
          // Signal completion - callbacks can handle cleanup if needed
          break;
      }
    } catch (error) {
      this.logError('parseExecutionResult', error);
    }
  }
}
