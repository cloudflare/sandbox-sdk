/**
 * Utility functions used by the bridge routes.
 */

import { streamFile } from '../file-stream';
import type { ErrorResponse } from './types';

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * UTF-8-safe base64 encoding.
 * btoa() only handles latin-1; encode to UTF-8 bytes first via TextEncoder.
 */
export function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** RFC 4648 base32 encoding (lowercase). Returns only [a-z2-7]. */
export function base32Encode(data: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function errorJson(
  error: string,
  code: string,
  status: number
): Response {
  const body: ErrorResponse = { error, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/**
 * Shell-quote a single argv token so it is safe to embed in a sh command
 * string.  Tokens that contain only safe characters are returned unchanged
 * for readability.  All others are wrapped in ANSI-C $'...' quoting which
 * can represent newlines, tabs, and other control characters as escape
 * sequences — unlike plain single quotes which pass content literally and
 * break when the value contains a real newline.
 */
export function shellQuote(arg: string): string {
  // Fast path: arg contains only safe characters.
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  // Use $'...' (ANSI-C quoting) which supports escape sequences.
  // Escape backslashes first, then single quotes and control characters.
  const escaped = arg
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `$'${escaped}'`;
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * POSIX-normalise a path (resolve `.` / `..` segments) and verify it lives
 * under /workspace.  Returns the resolved absolute path on success, or null
 * if the path escapes the workspace.
 */
export function resolveWorkspacePath(userPath: string): string | null {
  // Treat relative paths as relative to /workspace
  const abs = userPath.startsWith('/') ? userPath : `/workspace/${userPath}`;

  // Normalise: split on '/', resolve '.' and '..'
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const resolved = `/${parts.join('/')}`;

  // Must be exactly /workspace or start with /workspace/
  if (resolved === '/workspace' || resolved.startsWith('/workspace/')) {
    return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session ID validation
// ---------------------------------------------------------------------------

/**
 * Validate a session ID. Rejects path traversal, control chars, and excessive length.
 * Returns the validated ID or null if invalid.
 */
export function validateSessionId(id: string): string | null {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) return null;
  if (id.includes('..')) return null;
  return id;
}

// ---------------------------------------------------------------------------
// SSE-to-binary stream conversion
// ---------------------------------------------------------------------------

/**
 * Convert an SSE stream from readFileStream() into a raw byte stream.
 * Decodes base64 chunks for binary files and UTF-8-encodes text chunks.
 */
export function sseToByteStream(
  sse: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamFile(sse)) {
          controller.enqueue(
            chunk instanceof Uint8Array ? chunk : encoder.encode(chunk)
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });
}
