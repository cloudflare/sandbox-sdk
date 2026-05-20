/**
 * Retry `fetch(url)` until the response body matches `expectedBody` or
 * the retry budget is exhausted. Used by the tunnel E2E tests where the
 * Cloudflare edge can take a few seconds to propagate after `/ready`
 * reports the tunnel is up.
 *
 * Throws an Error reporting the last failure if the body never matches.
 */
export async function fetchWithRetry(
  url: string,
  expectedBody: string,
  opts: { tries: number; delayMs: number }
): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < opts.tries; i++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) {
        const body = await response.text();
        if (body === expectedBody) return body;
        lastError = new Error(
          `Unexpected body (status ${response.status}): ${body.slice(0, 80)}`
        );
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  throw new Error(
    `fetchWithRetry failed for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
