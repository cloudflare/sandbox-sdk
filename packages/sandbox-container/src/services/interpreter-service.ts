import { randomUUID } from 'node:crypto';
import type { Logger } from '@repo/shared';
import type {
  CodeExecutionContext,
  ContextNotFoundContext,
  InternalErrorContext,
  InterpreterNotReadyContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type { ServiceResult } from '../core/types';
import {
  type InterpreterLanguage,
  processPool,
  type RichOutput
} from '../runtime/process-pool';

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
    this.name = 'InterpreterNotReadyError';
  }
}

/**
 * Interpreter service for managing code execution contexts
 */
export class InterpreterService {
  private contexts: Map<string, Context> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Get health status of the interpreter
   */
  async getHealthStatus(): Promise<ServiceResult<HealthStatus>> {
    try {
      return {
        success: true,
        data: {
          ready: true,
          initializing: false,
          progress: 100
        }
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to get health status',
        error instanceof Error ? error : undefined
      );

      return {
        success: false,
        error: {
          message: `Failed to get interpreter health status: ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * Create a new code execution context
   */
  async createContext(
    request: CreateContextRequest
  ): Promise<ServiceResult<Context>> {
    let executorReserved = false;
    let contextId: string | undefined;
    let language: InterpreterLanguage | undefined;

    try {
      contextId = randomUUID();
      language = this.mapLanguage(
        request.language || 'python'
      ) as InterpreterLanguage;

      const context: Context = {
        id: contextId,
        language,
        cwd: request.cwd || '/workspace',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      };

      await processPool.reserveExecutorForContext(contextId, language);
      executorReserved = true;

      this.contexts.set(contextId, context);

      return {
        success: true,
        data: context
      };
    } catch (error) {
      // If executor was reserved but context creation failed, release it
      if (executorReserved && contextId && language) {
        try {
          await processPool.releaseExecutorForContext(contextId, language);
        } catch (releaseError) {
          this.logger.error(
            'Failed to release executor after context creation failure',
            releaseError as Error,
            { contextId, language }
          );
        }
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to create context',
        error instanceof Error ? error : undefined,
        { request }
      );

      if (error instanceof InterpreterNotReadyError) {
        return {
          success: false,
          error: {
            message: error.message,
            code: ErrorCode.INTERPRETER_NOT_READY,
            details: {
              progress: error.progress,
              retryAfter: error.retryAfter
            } satisfies InterpreterNotReadyContext
          }
        };
      }

      // Check for Python not available error
      if (errorMessage.includes('Python interpreter not available')) {
        return {
          success: false,
          error: {
            message: errorMessage,
            code: ErrorCode.PYTHON_NOT_AVAILABLE,
            details: {
              originalError: errorMessage
            } satisfies InternalErrorContext
          }
        };
      }

      return {
        success: false,
        error: {
          message: `Failed to create code context: ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * List all code contexts
   */
  async listContexts(): Promise<ServiceResult<Context[]>> {
    try {
      const contexts = Array.from(this.contexts.values());

      return {
        success: true,
        data: contexts
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to list contexts',
        error instanceof Error ? error : undefined
      );

      return {
        success: false,
        error: {
          message: `Failed to list code contexts: ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * Delete a code context
   */
  async deleteContext(contextId: string): Promise<ServiceResult<void>> {
    try {
      const context = this.contexts.get(contextId);
      if (!context) {
        return {
          success: false,
          error: {
            message: `Code context '${contextId}' not found`,
            code: ErrorCode.CONTEXT_NOT_FOUND,
            details: {
              contextId
            } satisfies ContextNotFoundContext
          }
        };
      }

      try {
        await processPool.releaseExecutorForContext(
          contextId,
          context.language as InterpreterLanguage
        );
      } catch (error) {
        this.logger.error(
          'Failed to release executor for context',
          error as Error,
          {
            contextId,
            language: context.language
          }
        );
        throw error;
      } finally {
        // Always remove context from map, even if release fails
        this.contexts.delete(contextId);
      }

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to delete context',
        error instanceof Error ? error : undefined,
        { contextId }
      );

      return {
        success: false,
        error: {
          message: `Failed to delete code context '${contextId}': ${errorMessage}`,
          code: ErrorCode.INTERNAL_ERROR,
          details: {
            contextId,
            originalError: errorMessage
          } satisfies InternalErrorContext
        }
      };
    }
  }

  /**
   * Execute code in a context
   * Returns a Response with streaming output (SSE format)
   *
   * Note: This method returns Response directly rather than ServiceResult<Response>
   * because streaming responses need special handling. Error responses are still
   * returned as Response objects with appropriate status codes.
   */
  async executeCode(
    contextId: string,
    code: string,
    language?: string
  ): Promise<Response> {
    try {
      const context = this.contexts.get(contextId);
      if (!context) {
        return new Response(
          JSON.stringify({
            error: `Context ${contextId} not found`
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      context.lastUsed = new Date().toISOString();

      // Check if executor is healthy
      if (!processPool.isContextExecutorHealthy(contextId)) {
        return new Response(
          JSON.stringify({
            error: `Context executor has terminated. Please delete and recreate the context.`,
            code: ErrorCode.INTERNAL_ERROR,
            details: {
              contextId
            }
          }),
          {
            status: 410,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      const execLanguage = this.mapLanguage(language || context.language);
      const self = this;

      const result = await processPool.execute(
        execLanguage,
        code,
        contextId,
        undefined
      );

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          try {
            if (result.stdout) {
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: 'stdout',
                    text: result.stdout
                  })
                )
              );
            }

            if (result.stderr) {
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: 'stderr',
                    text: result.stderr
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
                      type: 'result',
                      ...outputData,
                      metadata: output.metadata || {}
                    })
                  )
                );
              }
            }

            if (result.success) {
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: 'execution_complete',
                    execution_count: 1
                  })
                )
              );
            } else if (result.error) {
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: 'error',
                    ename: result.error.type || 'ExecutionError',
                    evalue: result.error.message || 'Code execution failed',
                    traceback: result.error.traceback
                      ? result.error.traceback.split('\n')
                      : []
                  })
                )
              );
            } else {
              controller.enqueue(
                encoder.encode(
                  self.formatSSE({
                    type: 'error',
                    ename: 'ExecutionError',
                    evalue: result.stderr || 'Code execution failed',
                    traceback: []
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
                  type: 'error',
                  ename: 'InternalError',
                  evalue:
                    error instanceof Error ? error.message : String(error),
                  traceback: []
                })
              )
            );

            controller.close();
          }
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        }
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to execute code',
        error instanceof Error ? error : undefined,
        { contextId }
      );

      // Return error as JSON response
      return new Response(
        JSON.stringify({
          error: {
            message: `Failed to execute code in context '${contextId}': ${errorMessage}`,
            code: ErrorCode.CODE_EXECUTION_ERROR,
            details: {
              contextId,
              evalue: errorMessage
            } satisfies CodeExecutionContext
          }
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }

  private mapLanguage(language: string): InterpreterLanguage {
    const normalized = language.toLowerCase();

    switch (normalized) {
      case 'python':
      case 'python3':
        return 'python';
      case 'javascript':
      case 'js':
      case 'node':
        return 'javascript';
      case 'typescript':
      case 'ts':
        return 'typescript';
      default:
        this.logger.warn('Unknown language, defaulting to python', {
          requestedLanguage: language
        });
        return 'python';
    }
  }

  private formatOutputData(output: RichOutput): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    switch (output.type) {
      case 'image':
        result.png = output.data;
        break;
      case 'jpeg':
        result.jpeg = output.data;
        break;
      case 'svg':
        result.svg = output.data;
        break;
      case 'html':
        result.html = output.data;
        break;
      case 'json':
        result.json =
          typeof output.data === 'string'
            ? JSON.parse(output.data)
            : output.data;
        break;
      case 'latex':
        result.latex = output.data;
        break;
      case 'markdown':
        result.markdown = output.data;
        break;
      case 'javascript':
        result.javascript = output.data;
        break;
      case 'text':
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
