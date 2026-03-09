import type { Sandbox } from '@cloudflare/sandbox';

import type { ServiceConfig } from '../../proxy';

/**
 * Anthropic API proxy for Claude Code and Claude SDKs.
 *
 * Claude Code and the Anthropic SDK read ANTHROPIC_BASE_URL automatically,
 * so sandbox code works without modification.
 */

export const anthropic: ServiceConfig<Env> = {
  target: 'https://api.anthropic.com',

  validate: (req) => req.headers.get('x-api-key'),

  transform: async (req, ctx) => {
    if (!ctx.env.ANTHROPIC_API_KEY) {
      return new Response('ANTHROPIC_API_KEY not configured', { status: 500 });
    }
    req.headers.set('x-api-key', ctx.env.ANTHROPIC_API_KEY);
    return req;
  }
};

export async function configureAnthropic(
  sandbox: Sandbox,
  proxyBase: string,
  token: string
) {
  await sandbox.exec(
    `echo 'ANTHROPIC_BASE_URL=${proxyBase}/proxy/anthropic' >> /workspace/.env`
  );
  await sandbox.exec(`echo 'ANTHROPIC_API_KEY=${token}' >> /workspace/.env`);
}
