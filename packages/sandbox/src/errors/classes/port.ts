import type {
  ErrorResponse,
  InternalErrorContext,
  InvalidPortContext,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext
} from '@repo/shared/errors';
import { SandboxError } from './base';

// ============================================================================
// Port Errors
// ============================================================================

/**
 * Error thrown when exposing a port that is already exposed.
 */
export class PortAlreadyExposedError extends SandboxError<PortAlreadyExposedContext> {
  constructor(errorResponse: ErrorResponse<PortAlreadyExposedContext>) {
    super(errorResponse);
    this.name = 'PortAlreadyExposedError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
}

/**
 * Error thrown when operating on a port that has not been exposed.
 */
export class PortNotExposedError extends SandboxError<PortNotExposedContext> {
  constructor(errorResponse: ErrorResponse<PortNotExposedContext>) {
    super(errorResponse);
    this.name = 'PortNotExposedError';
  }

  // Type-safe accessor
  get port() {
    return this.context.port;
  }
}

/**
 * Error thrown when a port number is invalid
 */
export class InvalidPortError extends SandboxError<InvalidPortContext> {
  constructor(errorResponse: ErrorResponse<InvalidPortContext>) {
    super(errorResponse);
    this.name = 'InvalidPortError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get reason() {
    return this.context.reason;
  }
}

/**
 * Error thrown when a service on a port is not responding
 */
export class ServiceNotRespondingError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'ServiceNotRespondingError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
}

/**
 * Error thrown when a port is already in use
 */
export class PortInUseError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'PortInUseError';
  }

  // Type-safe accessor
  get port() {
    return this.context.port;
  }
}

/**
 * Generic port operation error
 */
export class PortError extends SandboxError<PortErrorContext> {
  constructor(errorResponse: ErrorResponse<PortErrorContext>) {
    super(errorResponse);
    this.name = 'PortError';
  }

  // Type-safe accessors
  get port() {
    return this.context.port;
  }
  get portName() {
    return this.context.portName;
  }
  get stderr() {
    return this.context.stderr;
  }
}

/**
 * Error thrown when port exposure requires a custom domain
 */
export class CustomDomainRequiredError extends SandboxError<InternalErrorContext> {
  constructor(errorResponse: ErrorResponse<InternalErrorContext>) {
    super(errorResponse);
    this.name = 'CustomDomainRequiredError';
  }
}
