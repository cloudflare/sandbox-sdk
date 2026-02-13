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

import { backupOpencodeStorage, restoreOpencodeBackup } from './backup';

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

async function ensureOpencodeStorageRestored(
  sandbox: ReturnType<typeof getSandbox>,
  bucket: R2Bucket | undefined
): Promise<void> {
  if (!bucket) {
    console.log('[RESTORE] No SESSIONS_BUCKET configured, skipping restore');
    return;
  }

  console.log('[RESTORE] Starting restore check...');

  // Check if storage directory exists and has content FIRST
  // We restore based on storage state, not server state
  const dirCheck = await sandbox.exec(
    'if [ -d ~/.local/share/opencode/storage ]; then echo exists; else echo missing; fi'
  );
  const dirExists = dirCheck.stdout.trim() === 'exists';
  console.log('[RESTORE] Storage directory exists:', dirExists);

  // Check if storage directory has content
  let hasContent = false;
  if (dirExists) {
    const contentCheck = await sandbox.exec(
      'if [ -n "$(ls -A ~/.local/share/opencode/storage 2>/dev/null)" ]; then echo has_content; else echo empty; fi'
    );
    hasContent = contentCheck.stdout.trim() === 'has_content';
    console.log('[RESTORE] Storage directory has content:', hasContent);
  }

  // If storage exists with content, no restore needed
  if (dirExists && hasContent) {
    console.log(
      '[RESTORE] Storage directory exists with content, no restore needed'
    );
    return;
  }

  // Check if OpenCode server is running - if so, warn but still attempt restore
  const processes = await sandbox.listProcesses();

  const hasOpencodeProcess = processes.some(
    (proc) =>
      (proc.status === 'starting' || proc.status === 'running') &&
      proc.command.includes('opencode serve')
  );

  if (!dirExists || !hasContent) {
    // If server is running but storage is missing, we need to stop it before restoring
    // Otherwise the server won't see the restored data
    if (hasOpencodeProcess) {
      console.log(
        '[RESTORE] Server is running but storage is missing/empty. Stopping server to restore...'
      );
      const opencodeProc = processes.find(
        (proc) =>
          (proc.status === 'starting' || proc.status === 'running') &&
          proc.command.includes('opencode serve')
      );
      if (opencodeProc) {
        await sandbox.killProcess(opencodeProc.id, 'SIGTERM');
        console.log('[RESTORE] Server stopped');
      }
    }
    console.log(
      '[RESTORE] Storage missing or empty, attempting restore from backup...'
    );

    // Remove existing empty directory if it exists (OpenCode might have created it)
    if (dirExists && !hasContent) {
      console.log('[RESTORE] Removing empty storage directory...');
      await sandbox.exec('rm -rf ~/.local/share/opencode/storage');
    }

    // Check if backup exists in R2
    const backupCheck = await bucket.get('opencode-backup');
    if (!backupCheck) {
      console.log('[RESTORE] No backup found in R2, skipping restore');
      return;
    }

    console.log('[RESTORE] Backup found, restoring...');
    const restored = await restoreOpencodeBackup(sandbox, bucket);

    if (restored) {
      // Verify restore succeeded
      const verifyDirCheck = await sandbox.exec(
        'if [ -d ~/.local/share/opencode/storage ]; then echo exists; else echo missing; fi'
      );
      const verifyContentCheck = await sandbox.exec(
        'if [ -n "$(ls -A ~/.local/share/opencode/storage 2>/dev/null)" ]; then echo has_content; else echo empty; fi'
      );

      if (
        verifyDirCheck.stdout.trim() === 'exists' &&
        verifyContentCheck.stdout.trim() === 'has_content'
      ) {
        console.log('[RESTORE] Storage restored successfully');
      } else {
        console.error(
          '[RESTORE] Restore completed but verification failed - dir:',
          verifyDirCheck.stdout.trim(),
          'content:',
          verifyContentCheck.stdout.trim()
        );
      }
    } else {
      console.error(
        '[RESTORE] Restore function returned false (check restore logs for details)'
      );
    }
  } else {
    console.log(
      '[RESTORE] Storage directory exists with content, no restore needed'
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Restore OpenCode backup if needed (before server starts)
    await ensureOpencodeStorageRestored(sandbox, env.SESSIONS_BUCKET);

    // Programmatic SDK test endpoint
    if (request.method === 'POST' && url.pathname === '/api/test') {
      const response = await handleSdkTest(sandbox, env);

      // Backup OpenCode storage after operations (in background, non-blocking)
      if (env.SESSIONS_BUCKET) {
        ctx.waitUntil(
          backupOpencodeStorage(sandbox, env.SESSIONS_BUCKET).catch((err) =>
            console.error('Failed to backup OpenCode storage:', err)
          )
        );
      }

      return response;
    }

    // Everything else: Web UI proxy
    const server = await createOpencodeServer(sandbox, {
      directory: '/home/user/agents',
      config: getConfig(env)
    });

    const response = await proxyToOpencode(request, sandbox, server);

    // Backup OpenCode storage after write operations (in background, non-blocking)
    // Only backup on POST/PUT/PATCH/DELETE to avoid excessive backups
    const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method
    );
    if (env.SESSIONS_BUCKET && isWriteOperation) {
      ctx.waitUntil(
        backupOpencodeStorage(sandbox, env.SESSIONS_BUCKET).catch((err) =>
          console.error('Failed to backup OpenCode storage:', err)
        )
      );
    }

    return response;
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
