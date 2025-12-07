export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'MISSING_AUTH'
      | 'INVALID_FORMAT'
      | 'INVALID_KEY' = 'INVALID_KEY'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function validateApiKey(request: Request, expectedKey: string): boolean {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    throw new AuthError('Missing Authorization header', 'MISSING_AUTH');
  }

  if (!authHeader.startsWith('Bearer ')) {
    throw new AuthError(
      'Invalid Authorization format. Expected: Bearer <token>',
      'INVALID_FORMAT'
    );
  }

  const token = authHeader.slice(7);

  if (token !== expectedKey) {
    throw new AuthError('Invalid API key', 'INVALID_KEY');
  }

  return true;
}

export function createAuthErrorResponse(error: AuthError): Response {
  return Response.json(
    { error: error.code, message: error.message },
    { status: 401 }
  );
}
