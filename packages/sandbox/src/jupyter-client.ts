import { HttpClient } from "./client.js";
import { isRetryableError, parseErrorResponse } from "./errors.js";
import type {
  CodeContext,
  CreateContextOptions,
  ExecutionError,
  OutputMessage,
  Result,
} from "./interpreter-types.js";

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

export class JupyterClient extends HttpClient {
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

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
        throw await parseErrorResponse(response);
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
        throw await parseErrorResponse(response);
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
            // Convert raw result to Result interface
            const result: Result = {
              text: data.text,
              html: data.html,
              png: data.png,
              jpeg: data.jpeg,
              svg: data.svg,
              latex: data.latex,
              markdown: data.markdown,
              javascript: data.javascript,
              json: data.json,
              chart: data.chart,
              data: data.data,
              formats: () => {
                const formats: string[] = [];
                if (data.text) formats.push("text");
                if (data.html) formats.push("html");
                if (data.png) formats.push("png");
                if (data.jpeg) formats.push("jpeg");
                if (data.svg) formats.push("svg");
                if (data.latex) formats.push("latex");
                if (data.markdown) formats.push("markdown");
                if (data.javascript) formats.push("javascript");
                if (data.json) formats.push("json");
                if (data.chart) formats.push("chart");
                return formats;
              },
            };
            await callbacks.onResult(result);
          }
          break;

        case "error":
          if (callbacks.onError) {
            await callbacks.onError({
              name: data.ename || "Error",
              value: data.evalue || data.text || "Unknown error",
              traceback: data.traceback || [],
              lineNumber: data.lineNumber,
            });
          }
          break;

        case "execution_complete":
          // Execution completed successfully
          break;
      }
    } catch (error) {
      console.error("[JupyterClient] Error parsing execution result:", error);
    }
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    return this.executeWithRetry(async () => {
      const response = await this.doFetch("/api/contexts", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw await parseErrorResponse(response);
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
        throw await parseErrorResponse(response);
      }
    });
  }

  // Override parent doFetch to be public for this class
  public async doFetch(path: string, options?: RequestInit): Promise<Response> {
    return super.doFetch(path, options);
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

        // Check if it's a retryable error (circuit breaker or Jupyter not ready)
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

        // Non-retryable error or last attempt - throw immediately
        throw error;
      }
    }

    // All retries exhausted - throw a clean error without implementation details
    if (lastError?.message.includes("Code execution")) {
      // If the error already has a clean message about code execution, use it
      throw lastError;
    }

    // Otherwise, throw a generic but user-friendly error
    throw new Error("Unable to execute code at this time");
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    // Use the SDK's built-in retryable check
    if (isRetryableError(error)) {
      return true;
    }

    // Also check for circuit breaker specific errors
    if (error instanceof Error) {
      // Circuit breaker errors (from the container's response)
      if (error.message.includes("Circuit breaker is open")) {
        return true;
      }

      // Check if error has a status property
      if ("status" in error && error.status === "circuit_open") {
        return true;
      }
    }

    return false;
  }
}
