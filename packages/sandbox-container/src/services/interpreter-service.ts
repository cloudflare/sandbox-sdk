// Wrapper service following init-testing's ServiceResult<T> pattern
import type { Logger, ServiceResult } from '../core/types';
import {
  type Context,
  InterpreterService as CoreInterpreterService,
  type CreateContextRequest,
  type HealthStatus,
  InterpreterNotReadyError
} from '../interpreter-service';

/**
 * Interpreter service wrapper that follows the ServiceResult<T> pattern
 * Wraps the core InterpreterService to maintain consistency with other services
 */
export class InterpreterService {
  private coreService: CoreInterpreterService;

  constructor(private logger: Logger) {
    this.coreService = new CoreInterpreterService();
    this.logger.info('InterpreterService initialized');
  }

  /**
   * Get health status of the interpreter
   */
  async getHealthStatus(): Promise<ServiceResult<HealthStatus>> {
    try {
      const status = await this.coreService.getHealthStatus();

      return {
        success: true,
        data: status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get health status', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: 'Failed to get interpreter health status',
          code: 'HEALTH_CHECK_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  /**
   * Create a new code execution context
   */
  async createContext(request: CreateContextRequest): Promise<ServiceResult<Context>> {
    try {
      this.logger.info('Creating code context', { request });

      const context = await this.coreService.createContext(request);

      this.logger.info('Code context created', { contextId: context.id });

      return {
        success: true,
        data: context,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create context', error instanceof Error ? error : undefined, { request });

      if (error instanceof InterpreterNotReadyError) {
        return {
          success: false,
          error: {
            message: error.message,
            code: 'INTERPRETER_NOT_READY',
            details: {
              progress: error.progress,
              retryAfter: error.retryAfter,
            },
          },
        };
      }

      return {
        success: false,
        error: {
          message: 'Failed to create code context',
          code: 'CONTEXT_CREATE_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  /**
   * List all code contexts
   */
  async listContexts(): Promise<ServiceResult<Context[]>> {
    try {
      const contexts = await this.coreService.listContexts();

      return {
        success: true,
        data: contexts,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list contexts', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: 'Failed to list code contexts',
          code: 'CONTEXT_LIST_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  /**
   * Delete a code context
   */
  async deleteContext(contextId: string): Promise<ServiceResult<void>> {
    try {
      this.logger.info('Deleting code context', { contextId });

      await this.coreService.deleteContext(contextId);

      this.logger.info('Code context deleted', { contextId });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete context', error instanceof Error ? error : undefined, { contextId });

      // Check if it's a "not found" error
      if (errorMessage.includes('not found')) {
        return {
          success: false,
          error: {
            message: `Context ${contextId} not found`,
            code: 'CONTEXT_NOT_FOUND',
            details: { contextId },
          },
        };
      }

      return {
        success: false,
        error: {
          message: 'Failed to delete code context',
          code: 'CONTEXT_DELETE_ERROR',
          details: { contextId, originalError: errorMessage },
        },
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
      this.logger.info('Executing code', { contextId, language });

      // The core service returns a Response directly for streaming
      const response = await this.coreService.executeCode(contextId, code, language);

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to execute code', error instanceof Error ? error : undefined, { contextId });

      // Return error as JSON response
      return new Response(
        JSON.stringify({
          error: {
            message: 'Failed to execute code',
            code: 'CODE_EXECUTION_ERROR',
            details: { contextId, originalError: errorMessage },
          },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
}
