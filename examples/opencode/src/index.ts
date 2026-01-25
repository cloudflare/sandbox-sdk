/**
 * OpenCode + Sandbox SDK Example
 *
 * This example demonstrates both ways to use OpenCode with Sandbox:
 * 1. Web UI - Browse to / for the full OpenCode web experience
 * 2. Programmatic - POST to /api/test for SDK-based automation
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode
} from '@cloudflare/sandbox/opencode';
import type { Config, Part } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

export { Sandbox } from '@cloudflare/sandbox';

const getConfig = (env: Env): Config => ({
  provider: {
    // Option A: Direct Anthropic provider (requires ANTHROPIC_API_KEY)
    anthropic: {
      options: {
        apiKey: env.ANTHROPIC_API_KEY
      }
    }

    // Option B: Cloudflare AI Gateway with unified billing (no provider API keys needed).
    // Models must be declared explicitly under 'models' using the provider/model format.
    // for the OpenCode CLI automatically.
    // 'cloudflare-ai-gateway': {
    //   options: {
    //     accountId: env.CLOUDFLARE_ACCOUNT_ID,
    //     gatewayId: env.CLOUDFLARE_GATEWAY_ID,
    //     apiToken: env.CLOUDFLARE_API_TOKEN
    //   },
    //   models: {
    //     'anthropic/claude-opus-4-6': {},
    //   }
    // }
  }
});

/**
 * Optional: Build custom environment variables to pass to OpenCode.
 * Useful for OTEL telemetry, distributed tracing, or other custom needs.
 *
 * @example
 * const customEnv = getCustomEnv(env, request);
 * const server = await createOpencodeServer(sandbox, {
 *   config: getConfig(env),
 *   env: customEnv,
 * });
 */
const getCustomEnv = (
  env: Env,
  request: Request
): Record<string, string> | undefined => {
  const customEnv: Record<string, string> = {};

  // Propagate W3C trace context for distributed tracing
  const traceparent = request.headers.get('traceparent');
  if (traceparent) {
    customEnv.TRACEPARENT = traceparent;
  }

  // Example: Configure OTEL telemetry endpoint
  // if (env.OTEL_ENDPOINT) {
  //   customEnv.OTEL_EXPORTER_OTLP_ENDPOINT = env.OTEL_ENDPOINT;
  //   customEnv.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
  // }

  return Object.keys(customEnv).length > 0 ? customEnv : undefined;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Programmatic SDK test endpoint
    if (request.method === 'POST' && url.pathname === '/api/test') {
      return handleSdkTest(sandbox, env);
    }

    // Everything else: Web UI proxy
    const server = await createOpencodeServer(sandbox, {
      directory: '/home/user/agents',
      config: getConfig(env)
      // Optional: Pass custom environment variables (e.g., for tracing/telemetry)
      // env: getCustomEnv(env, request),
    });
    return proxyToOpencode(request, sandbox, server);
  }
};

/**
 * Test the programmatic SDK access
 */
async function handleSdkTest(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<Response> {
  try {
    // Get typed SDK client
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: '/home/user/agents',
      config: getConfig(env)
    });

    // Create a session
    const session = await client.session.create({
      title: 'Test Session',
      directory: '/home/user/agents'
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Send a prompt using the SDK
    const promptResult = await client.session.prompt({
      sessionID: session.data.id,
      directory: '/home/user/agents',
      parts: [
        {
          type: 'text',
          text: 'Summarize the README.md file in 2-3 sentences. Be concise.'
        }
      ]
    });

    // Extract text response from result
    const parts = promptResult.data?.parts ?? [];
    const textPart = parts.find(
      (part): part is Part & { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string'
    );

    return new Response(textPart?.text ?? 'No response', {
      headers: { 'Content-Type': 'text/plain' }
    });
  } catch (error) {
    console.error('SDK test error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    return Response.json(
      { success: false, error: message, stack },
      { status: 500 }
    );
  }
}
