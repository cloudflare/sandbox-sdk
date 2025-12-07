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
