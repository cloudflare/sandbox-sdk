export interface ParsedRoute {
  sandboxId: string;
  path: string;
  segments: string[];
}

const API_PREFIX = '/api/sandbox/';

export function parseRoute(url: URL): ParsedRoute | null {
  const pathname = url.pathname;

  if (!pathname.startsWith(API_PREFIX)) {
    return null;
  }

  const remainder = pathname.slice(API_PREFIX.length);
  const slashIndex = remainder.indexOf('/');

  if (slashIndex === -1) {
    // No path after sandbox ID
    return null;
  }

  const sandboxId = remainder.slice(0, slashIndex);
  const path = remainder.slice(slashIndex);
  const segments = path.slice(1).split('/').filter(Boolean);

  if (!sandboxId || segments.length === 0) {
    return null;
  }

  return { sandboxId, path, segments };
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

export function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

export function addCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}
