import type { ErrorResponse, OperationType } from '@repo/shared/errors';

type ErrorOperation<TContext> =
  | OperationType
  | (TContext extends { operation: infer TOperation } ? TOperation : never)
  | undefined;

export class SandboxError<TContext = Record<string, unknown>> extends Error {
  constructor(
    public readonly errorResponse: ErrorResponse<TContext>,
    options?: { cause?: unknown }
  ) {
    super(errorResponse.message, options);
    this.name = 'SandboxError';
  }

  get code() {
    return this.errorResponse.code;
  }
  get context() {
    return this.errorResponse.context;
  }
  get httpStatus() {
    return this.errorResponse.httpStatus;
  }
  get operation(): ErrorOperation<TContext> {
    return this.errorResponse.operation;
  }
  get suggestion() {
    return this.errorResponse.suggestion;
  }
  get timestamp() {
    return this.errorResponse.timestamp;
  }
  get documentation() {
    return this.errorResponse.documentation;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      httpStatus: this.httpStatus,
      operation: this.operation,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
      documentation: this.documentation,
      stack: this.stack
    };
  }
}
