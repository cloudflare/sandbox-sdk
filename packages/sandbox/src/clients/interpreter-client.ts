import { BaseHttpClient } from './base-client.js';
import { mapContainerError } from '../utils/error-mapping.js';
import { InterpreterNotReadyError } from '../errors.js';
import {
  type CodeContext,
  type CreateContextOptions,
  type ExecutionError,
  type OutputMessage,
  type Result,
  ResultImpl,
} from '@repo/shared-types';
import type { HttpClientOptions } from './types.js';

// API Response types
interface ContextResponse {
  id: string;
  language: string;
  cwd: string;
  createdAt: string; // ISO date string from JSON
  lastUsed: string; // ISO date string from JSON
}

interface ContextListResponse {
  contexts: ContextResponse[];
}

// Streaming execution data from the server
interface StreamingExecutionData {
  type: "result" | "stdout" | "stderr" | "error" | "execution_complete";
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
      | "line"
      | "bar"
      | "scatter"
      | "pie"
      | "histogram"
      | "heatmap"
      | "unknown";
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

  constructor(options: HttpClientOptions = {}) {
    super(options);
  }

  async createCodeContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch("/api/contexts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: options.language || "python",
          cwd: options.cwd || "/workspace",
          env_vars: options.envVars,
        }),
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      const data = (await response.json()) as ContextResponse;
      return {
        id: data.id,
        language: data.language,
        cwd: data.cwd,
        createdAt: new Date(data.createdAt),
        lastUsed: new Date(data.lastUsed),
      };
    });
  }

  async runCodeStream(
    contextId: string | undefined,
    code: string,
    language: string | undefined,
    callbacks: ExecutionCallbacks
  ): Promise<void> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch("/api/execute/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          context_id: contextId,
          code,
          language,
        }),
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      if (!response.body) {
        throw new Error("No response body for streaming execution");
      }

      // Process streaming response
      for await (const chunk of this.readLines(response.body)) {
        await this.parseExecutionResult(chunk, callbacks);
      }
    });
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch("/api/contexts", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }

      const data = (await response.json()) as ContextListResponse;
      return data.contexts.map((ctx) => ({
        id: ctx.id,
        language: ctx.language,
        cwd: ctx.cwd,
        createdAt: new Date(ctx.createdAt),
        lastUsed: new Date(ctx.lastUsed),
      }));
    });
  }

  async deleteCodeContext(contextId: string): Promise<void> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch(`/api/contexts/${contextId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const error = await this.parseErrorResponse(response);
        throw error;
      }
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
        lastError = error as Error;

        // Check if it's a retryable error (circuit breaker or interpreter not ready)
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

    throw lastError || new Error("Execution failed after retries");
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof InterpreterNotReadyError) {
      return true;
    }

    // Check for circuit breaker errors
    if (error instanceof Error) {
      return (
        error.message.includes("Circuit breaker") ||
        error.message.includes("not ready") ||
        error.message.includes("initializing")
      );
    }

    return false;
  }

  private async parseErrorResponse(response: Response): Promise<Error> {
    try {
      const errorData = await response.json();
      return mapContainerError(errorData as any);
    } catch {
      return new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  private async *readLines(
    stream: ReadableStream<Uint8Array>
  ): AsyncGenerator<string> {
    const reader = stream.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += new TextDecoder().decode(value);
        }
        if (done) break;

        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          yield buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf("\n");
        }
      }

      // Yield any remaining data
      if (buffer.length > 0) {
        yield buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async parseExecutionResult(
    line: string,
    callbacks: ExecutionCallbacks
  ) {
    if (!line.trim()) return;

    try {
      const data = JSON.parse(line) as StreamingExecutionData;

      switch (data.type) {
        case "stdout":
          if (callbacks.onStdout && data.text) {
            await callbacks.onStdout({
              text: data.text,
              timestamp: data.timestamp || Date.now(),
            });
          }
          break;

        case "stderr":
          if (callbacks.onStderr && data.text) {
            await callbacks.onStderr({
              text: data.text,
              timestamp: data.timestamp || Date.now(),
            });
          }
          break;

        case "result":
          if (callbacks.onResult) {
            // Create a ResultImpl instance from the raw data
            const result = new ResultImpl(data);
            await callbacks.onResult(result);
          }
          break;

        case "error":
          if (callbacks.onError) {
            await callbacks.onError({
              name: data.ename || "Error",
              value: data.evalue || "Unknown error",
              traceback: data.traceback || [],
            });
          }
          break;

        case "execution_complete":
          // Signal completion - callbacks can handle cleanup if needed
          break;
      }
    } catch (error) {
      console.error("Failed to parse execution result:", error);
    }
  }
}
