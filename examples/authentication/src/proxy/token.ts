import { jwtVerify, SignJWT } from 'jose';

import { ProxyTokenInvalidError } from './errors';
import type {
  CreateProxyTokenOptions,
  ProxyTokenPayload,
  VerifyProxyTokenOptions
} from './types';

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)(m|h|d)?$/);
  if (!match) {
    throw new Error(
      `Invalid expiresIn format: ${expiresIn}. Use '30m', '2h', '1d', or seconds.`
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return value;
  }
}

export async function createProxyToken(
  options: CreateProxyTokenOptions
): Promise<string> {
  const { secret, sandboxId, sessionId, expiresIn = '15m' } = options;

  if (!secret) throw new Error('JWT secret is required');
  if (!sandboxId) throw new Error('Sandbox ID is required');

  const secretKey = new TextEncoder().encode(secret);
  const expirationSeconds = parseExpiresIn(expiresIn);
  const now = Math.floor(Date.now() / 1000);

  const builder = new SignJWT({
    sandboxId,
    ...(sessionId && { sessionId })
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expirationSeconds);

  return builder.sign(secretKey);
}

export async function verifyProxyToken(
  options: VerifyProxyTokenOptions
): Promise<ProxyTokenPayload> {
  const { secret, token } = options;

  if (!secret) throw new Error('JWT secret is required');
  if (!token) throw new ProxyTokenInvalidError('Token is required');

  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ['HS256']
    });

    if (typeof payload.sandboxId !== 'string') {
      throw new ProxyTokenInvalidError('Missing sandboxId in token');
    }
    if (typeof payload.exp !== 'number') {
      throw new ProxyTokenInvalidError('Missing expiration in token');
    }
    if (typeof payload.iat !== 'number') {
      throw new ProxyTokenInvalidError('Missing issued-at in token');
    }

    return {
      sandboxId: payload.sandboxId,
      sessionId:
        typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      exp: payload.exp,
      iat: payload.iat
    };
  } catch (error) {
    if (error instanceof ProxyTokenInvalidError) throw error;

    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('expired')) {
      throw new ProxyTokenInvalidError('Token has expired');
    }
    if (message.includes('signature')) {
      throw new ProxyTokenInvalidError('Invalid token signature');
    }
    if (message.includes('malformed')) {
      throw new ProxyTokenInvalidError('Malformed token');
    }

    throw new ProxyTokenInvalidError(message);
  }
}
