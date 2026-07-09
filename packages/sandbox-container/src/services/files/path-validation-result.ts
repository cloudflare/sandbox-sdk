import type { ValidationFailedContext } from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type { ServiceError } from '../../core/types';

export function pathValidationError(
  path: string,
  errors: string[]
): ServiceError {
  return {
    message: `Invalid path format for '${path}': ${errors.join(', ')}`,
    code: ErrorCode.VALIDATION_FAILED,
    details: {
      validationErrors: errors.map((e) => ({
        field: 'path',
        message: e,
        code: 'INVALID_PATH'
      }))
    } satisfies ValidationFailedContext
  };
}
