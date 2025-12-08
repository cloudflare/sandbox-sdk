/**
 * OpenCode + Sandbox SDK Example
 *
 * This example demonstrates both ways to use OpenCode with Sandbox:
 * 1. Web UI - Browse to / for the full OpenCode web experience
 * 2. Programmatic - POST to /api/test for SDK-based automation
 */
import { getSandbox } from '@cloudflare/sandbox';
import { createOpencode, proxyToOpencode } from '@cloudflare/sandbox/opencode';
import type { Config, OpencodeClient } from '@opencode-ai/sdk';

export { Sandbox } from '@cloudflare/sandbox';

const getConfig = (env: Env): Config => ({
  provider: {
    anthropic: {
      options: {
        apiKey: env.ANTHROPIC_API_KEY
      }
    }
  }
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Programmatic SDK test endpoint
    if (request.method === 'POST' && url.pathname === '/api/test') {
      return handleSdkTest(sandbox, env);
    }

    // Everything else: Web UI proxy
    return proxyToOpencode(request, sandbox, { config: getConfig(env) });
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
    // Clone a repo to give the agent something to work with
    await sandbox.gitCheckout('https://github.com/cloudflare/agents.git', {
      targetDir: '/home/user/agents'
    });

    // Get typed SDK client
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      config: getConfig(env)
    });

    // Create a session
    const session = await client.session.create({
      body: { title: 'Test Session' },
      query: { directory: '/home/user/agents' }
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Send a prompt using the SDK
    const promptResult = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory: '/home/user/agents' },
      body: {
        model: {
          providerID: 'anthropic',
          modelID: 'claude-haiku-4-5'
        },
        parts: [
          {
            type: 'text',
            text: 'Summarize the README.md file in 2-3 sentences. Be concise.'
          }
        ]
      }
    });

    // Extract text response from result
    const parts = promptResult.data?.parts ?? [];
    const textPart = parts.find((p: { type: string }) => p.type === 'text') as
      | { text?: string }
      | undefined;

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
