import { SandboxSecurityError } from '../security';

const CUSTOM_TOKEN_PATTERN = /^[a-z0-9_]+$/;

export function assertValidCustomPreviewToken(token: string): void {
  if (token.length === 0) {
    throw new SandboxSecurityError(`Custom token cannot be empty.`);
  }

  if (token.length > 16) {
    throw new SandboxSecurityError(
      `Custom token too long. Maximum 16 characters allowed. Received: ${token.length} characters.`
    );
  }

  if (!CUSTOM_TOKEN_PATTERN.test(token)) {
    throw new SandboxSecurityError(
      `Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.`
    );
  }
}

export function generatePreviewToken(): string {
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);

  const base64 = btoa(String.fromCharCode(...array));
  return base64
    .replace(/\+/g, '_')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .toLowerCase();
}

export function previewTokensMatch(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(actual);

  try {
    return (
      crypto.subtle as SubtleCrypto & {
        timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
      }
    ).timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
