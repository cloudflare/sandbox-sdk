/** Shared Cloudflare API request primitives for tunnel helpers. */

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Pagination metadata on Cloudflare list endpoint responses. */
export interface ResultInfo {
  page: number;
  per_page: number;
  total_pages: number;
  count?: number;
  total_count?: number;
}

/** Cloudflare's standard envelope around every response. */
export interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: ResultInfo;
}

export type Fetcher = typeof fetch;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Treat these HTTP statuses as success and skip envelope parsing. */
  acceptStatuses?: number[];
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Default request timeout for Cloudflare control-plane calls. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Internal request helper. Centralises auth header, JSON encoding,
 * timeout enforcement, envelope parsing, and API error formatting so
 * endpoint wrappers stay declarative.
 */
export async function cfEnvelopeRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher,
  options: RequestOptions = {}
): Promise<CloudflareResponse<T> | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cloudflare API request to ${url} timed out after ${timeoutMs}ms`
      );
    }
    throw err;
  }
  if (options.acceptStatuses?.includes(response.status)) {
    return undefined;
  }

  let envelope: CloudflareResponse<T>;
  try {
    envelope = (await response.json()) as CloudflareResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API returned non-JSON response (status ${response.status}): ${message}`
    );
  }

  if (!response.ok || envelope.success === false) {
    const errs = envelope.errors ?? [];
    const summary = errs.length
      ? errs
          .map((e) => `${e.code ?? '???'}: ${e.message ?? 'unknown'}`)
          .join(', ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API error: ${summary}`);
  }

  return envelope;
}

/** Unwrap a successful Cloudflare response envelope to `result`. */
export async function cfRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher,
  options: RequestOptions = {}
): Promise<T | undefined> {
  return (await cfEnvelopeRequest<T>(url, token, fetcher, options))?.result;
}
