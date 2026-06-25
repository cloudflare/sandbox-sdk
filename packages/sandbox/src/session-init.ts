export class SessionInitInvalidatedError extends Error {
  constructor() {
    super('Default session initialization was invalidated by a container stop');
    this.name = 'SessionInitInvalidatedError';
  }
}

export function isSessionInitInvalidated(
  error: unknown
): error is SessionInitInvalidatedError {
  return error instanceof SessionInitInvalidatedError;
}
