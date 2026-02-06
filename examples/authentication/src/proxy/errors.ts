export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly httpStatus: number = 500
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

export class ProxyTokenMissingError extends ProxyError {
  constructor(service: string) {
    super(
      `No authentication token provided for service '${service}'`,
      'PROXY_TOKEN_MISSING',
      401
    );
    this.name = 'ProxyTokenMissingError';
  }
}

export class ProxyTokenInvalidError extends ProxyError {
  constructor(reason: string) {
    super(`Invalid proxy token: ${reason}`, 'PROXY_TOKEN_INVALID', 401);
    this.name = 'ProxyTokenInvalidError';
  }
}

export class ProxyServiceNotFoundError extends ProxyError {
  constructor(service: string, availableServices: string[]) {
    super(
      `Service '${service}' not configured. Available: ${availableServices.join(', ')}`,
      'PROXY_SERVICE_NOT_FOUND',
      404
    );
    this.name = 'ProxyServiceNotFoundError';
  }
}

export class ProxyPathInvalidError extends ProxyError {
  constructor(path: string, mountPath: string) {
    super(
      `Invalid proxy path '${path}'. Expected: ${mountPath}/{service}/{path}`,
      'PROXY_PATH_INVALID',
      400
    );
    this.name = 'ProxyPathInvalidError';
  }
}

export class ProxyTargetError extends ProxyError {
  constructor(service: string, target: string, cause: Error) {
    super(
      `Failed to proxy to ${service} (${target}): ${cause.message}`,
      'PROXY_TARGET_ERROR',
      502
    );
    this.name = 'ProxyTargetError';
    this.cause = cause;
  }
}
