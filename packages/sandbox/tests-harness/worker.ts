import { getSandbox, Sandbox } from '../src';

export class ReconstructionSandbox extends Sandbox {
  getStateForTest(): {
    envVars: Record<string, string>;
    sleepAfter: string | number;
  } {
    return { envVars: { ...this.envVars }, sleepAfter: this.sleepAfter };
  }
}

interface Env {
  Sandbox: DurableObjectNamespace<ReconstructionSandbox>;
}

interface CommandSnapshot {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

function getSandboxID(request: Request): string {
  return new URL(request.url).searchParams.get('sandboxId') ?? 'reconstruction';
}

async function runEnvironmentSnapshot(
  sandbox: ReturnType<typeof getSandbox<ReconstructionSandbox>>
): Promise<CommandSnapshot> {
  const process = await sandbox.exec([
    '/bin/bash',
    '-lc',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash parameter expansion.
    'printf %s "${HARNESS_MARKER-}"'
  ]);
  return process.output({ encoding: 'utf8' });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: error };

  const structured = error as Error & {
    code?: unknown;
    context?: unknown;
    httpStatus?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    code: structured.code,
    context: structured.context,
    httpStatus: structured.httpStatus
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, getSandboxID(request), {
      keepAlive: true,
      sleepAfter: '30m'
    });

    try {
      if (url.pathname === '/configure' && request.method === 'POST') {
        await sandbox.setEnvVars({ HARNESS_MARKER: 'configured' });
        return Response.json(await sandbox.getStateForTest());
      }

      if (url.pathname === '/state' && request.method === 'GET') {
        return Response.json(await sandbox.getStateForTest());
      }

      if (url.pathname === '/snapshot' && request.method === 'GET') {
        return Response.json(await runEnvironmentSnapshot(sandbox));
      }

      return new Response('not found', { status: 404 });
    } catch (error) {
      return Response.json(serializeError(error), { status: 500 });
    }
  }
};
