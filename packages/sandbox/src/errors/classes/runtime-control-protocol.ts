import { ErrorCode, getHttpStatus } from '@repo/shared/errors';
import { SandboxError } from './base';

export type RuntimeControlProtocolErrorReason =
  | 'missing-metadata'
  | 'malformed-metadata'
  | 'unsupported-protocol-version'
  | 'activation-mismatch';

export class RuntimeControlProtocolError extends SandboxError<{
  reason: RuntimeControlProtocolErrorReason;
  operation?: string;
}> {
  constructor(
    message: string,
    context: {
      reason: RuntimeControlProtocolErrorReason;
      operation?: string;
    },
    options?: { cause?: unknown }
  ) {
    super(
      {
        code: ErrorCode.INTERNAL_ERROR,
        message,
        context,
        httpStatus: getHttpStatus(ErrorCode.INTERNAL_ERROR),
        timestamp: new Date().toISOString()
      },
      options
    );
    this.name = 'RuntimeControlProtocolError';
  }
}
