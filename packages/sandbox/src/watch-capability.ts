import { ErrorCode } from '@repo/shared/errors';

export class UnsupportedMountWatchError extends Error {
  readonly code = ErrorCode.UNSUPPORTED_CAPABILITY;

  constructor(mountPath?: string, options?: ErrorOptions) {
    super(
      mountPath
        ? `The sandbox container image does not support local bucket watches at "${mountPath}". Rebuild the container image with the current @cloudflare/sandbox Dockerfile.`
        : 'The sandbox container image does not support local bucket watches',
      options
    );
    this.name = 'UnsupportedMountWatchError';
  }
}

export function translateRouteMountWatchError(error: unknown): never {
  const code = getErrorProperty(error, 'code');
  const httpStatus = getErrorProperty(error, 'httpStatus');
  if (httpStatus === 404 && code === ErrorCode.UNKNOWN_ERROR) {
    throw new UnsupportedMountWatchError(undefined, { cause: error });
  }
  throw error;
}

function getErrorProperty(
  error: unknown,
  property: 'code' | 'httpStatus'
): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  if (property in error) return Reflect.get(error, property);
  const response = Reflect.get(error, 'errorResponse');
  if (
    typeof response === 'object' &&
    response !== null &&
    property in response
  ) {
    return Reflect.get(response, property);
  }
  return undefined;
}
