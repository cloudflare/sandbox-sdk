import { randomUUID } from "node:crypto";
import type { Logger } from "@repo/shared";
import { type InterpreterLanguage, processPool, type RichOutput } from "./runtime/process-pool";

export interface CreateContextRequest {
  language?: string;
  cwd?: string;
}

export interface Context {
  id: string;
  language: string;
  cwd: string;
  createdAt: string;
  lastUsed: string;
}

export interface HealthStatus {
  ready: boolean;
  initializing: boolean;
  progress: number;
}

export class InterpreterNotReadyError extends Error {
  progress: number;
  retryAfter: number;

  constructor(message: string, progress: number = 100, retryAfter: number = 1) {
    super(message);
    this.progress = progress;
    this.retryAfter = retryAfter;
    this.name = "InterpreterNotReadyError";
  }
}

export class InterpreterService {
  private contexts: Map<string, Context> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async getHealthStatus(): Promise<HealthStatus> {
    return {
      ready: true,
      initializing: false,
      progress: 100,
    };
  }

  async createContext(request: CreateContextRequest): Promise<Context> {
    const id = randomUUID();
    const language = this.mapLanguage(request.language || "python");

    const context: Context = {
      id,
      language,
      cwd: request.cwd || "/workspace",
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };

    this.contexts.set(id, context);
    return context;
  }

  async listContexts(): Promise<Context[]> {
    return Array.from(this.contexts.values());
  }

  async deleteContext(contextId: string): Promise<void> {
    if (!this.contexts.has(contextId)) {
      throw new Error(`Context ${contextId} not found`);
    }

    this.contexts.delete(contextId);
  }

  async executeCode(
    contextId: string,
    code: string,
    language?: string,
    timeoutMs?: number
  ): Promise<Response> {
    const context = this.contexts.get(contextId);
    if (!context) {
      return new Response(
        JSON.stringify({
          error: `Context ${contextId} not found`,
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    context.lastUsed = new Date().toISOString();

    const execLanguage = this.mapLanguage(language || context.language);

    // Store reference to this for use in async function
    const self = this;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          // Pass through user-provided timeout (undefined = unlimited)
          const result = await processPool.execute(
            execLanguage,
            code,
            contextId,
            timeoutMs
          );

          if (result.stdout) {
            controller.enqueue(
              encoder.encode(
                self.formatSSE({
                  type: "stdout",
                  text: result.stdout,
                })
              )
            );
          }

          if (result.stderr) {
            controller.enqueue(
              encoder.encode(
                self.formatSSE({
                  type: "stderr",
                  text: result.stderr,
                })
              )
            );
          }

          if (result.outputs && result.outputs.length > 0) {
            for (const output of result.outputs) {
              const outputData = self.formatOutputData(output);
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: "result",
                    ...outputData,
                    metadata: output.metadata || {},
                  })
                )
              );
            }
          }

          if (result.success) {
            controller.enqueue(
              encoder.encode(
                self.formatSSE({
                  type: "execution_complete",
                  execution_count: 1,
                })
              )
            );
          } else if (result.error) {
            controller.enqueue(
              encoder.encode(
                self.formatSSE({
                  type: "error",
                  ename: result.error.type || "ExecutionError",
                  evalue: result.error.message || "Code execution failed",
                  traceback: result.error.traceback ? result.error.traceback.split('\n') : [],
                })
              )
            );
          } else {
            controller.enqueue(
              encoder.encode(
                self.formatSSE({
                  type: "error",
                  ename: "ExecutionError",
                  evalue: result.stderr || "Code execution failed",
                  traceback: [],
                })
              )
            );
          }

          controller.close();
        } catch (error) {
          self.logger.error('Code execution failed', error as Error, {
            contextId,
            language: execLanguage
          });

          controller.enqueue(
            encoder.encode(
              self.formatSSE({
                type: "error",
                ename: "InternalError",
                evalue: error instanceof Error ? error.message : String(error),
                traceback: [],
              })
            )
          );

          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private mapLanguage(language: string): InterpreterLanguage {
    const normalized = language.toLowerCase();

    switch (normalized) {
      case "python":
      case "python3":
        return "python";
      case "javascript":
      case "js":
      case "node":
        return "javascript";
      case "typescript":
      case "ts":
        return "typescript";
      default:
        this.logger.warn('Unknown language, defaulting to python', {
          requestedLanguage: language
        });
        return "python";
    }
  }

  private formatOutputData(output: RichOutput): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    switch (output.type) {
      case "image":
        result.png = output.data;
        break;
      case "jpeg":
        result.jpeg = output.data;
        break;
      case "svg":
        result.svg = output.data;
        break;
      case "html":
        result.html = output.data;
        break;
      case "json":
        result.json = typeof output.data === 'string' ? JSON.parse(output.data) : output.data;
        break;
      case "latex":
        result.latex = output.data;
        break;
      case "markdown":
        result.markdown = output.data;
        break;
      case "javascript":
        result.javascript = output.data;
        break;
      case "text":
        result.text = output.data;
        break;
      default:
        result.text = output.data || '';
    }

    return result;
  }

  /**
   * Format event as SSE (Server-Sent Events)
   * SSE format requires "data: " prefix and double newline separator
   * @param event - Event object to send
   * @returns SSE-formatted string
   */
  private formatSSE(event: Record<string, unknown>): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }
}
