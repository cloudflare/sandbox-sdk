/**
 * Outbound handler for api.anthropic.com.
 *
 * Intercepts requests from the sandbox to Anthropic's API and injects the
 * real API key. The sandbox never sees the credential — it can send any
 * placeholder value (or omit the header entirely).
 */
export async function anthropicHandler(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response('ANTHROPIC_API_KEY not configured', { status: 500 });
  }
  const req = new Request(request);
  req.headers.set('x-api-key', env.ANTHROPIC_API_KEY);
  return fetch(req);
}
