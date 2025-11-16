import { Sandbox, getSandbox } from '@cloudflare/sandbox';
export { Sandbox }; // export the Sandbox class for the worker

import {
  Agent,
  run,
  Shell,
  ShellAction,
  ShellResult,
  ShellOutputResult,
  shellTool
} from '@openai/agents';

// Tool result for API responses
interface ToolResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

class SandboxShell implements Shell {
  private sandbox: Sandbox;
  private cwd: string = '/workspace';
  public results: ToolResult[] = [];

  constructor(public readonly binding: DurableObjectNamespace<Sandbox>) {
    // Get a sandbox instance with a consistent ID
    this.sandbox = getSandbox(binding, 'shell-session');
  }

  async run(action: ShellAction): Promise<ShellResult> {
    const output: ShellResult['output'] = [];

    for (const command of action.commands) {
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = 0;
      let outcome: ShellOutputResult['outcome'] = {
        type: 'exit',
        exitCode: 0
      };
      try {
        const result = await this.sandbox.exec(command, {
          timeout: action.timeoutMs,
          cwd: this.cwd
        });
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
        // exec returns a result even for failed commands, so check success field
        // Timeout would be indicated by a specific error or exit code
        outcome = { type: 'exit', exitCode };
      } catch (error: any) {
        // Handle network/HTTP errors or timeout errors
        exitCode = typeof error?.exitCode === 'number' ? error.exitCode : null;
        stdout = error?.stdout ?? '';
        stderr = error?.stderr ?? '';

        // Check if it's a timeout error
        const errorMessage = error?.message ?? '';
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('Timeout') ||
          errorMessage.includes('timed out')
        ) {
          outcome = { type: 'timeout' };
        } else {
          outcome = { type: 'exit', exitCode: exitCode ?? 1 };
        }
      }
      output.push({
        command,
        stdout,
        stderr,
        outcome
      });

      // Collect results for API responses
      const collectedExitCode =
        outcome.type === 'exit' ? outcome.exitCode : null;
      this.results.push({
        command: String(command),
        stdout: String(stdout),
        stderr: String(stderr),
        exitCode: collectedExitCode
      });

      if (outcome.type === 'timeout') {
        break;
      }
    }

    return {
      output,
      providerData: {
        working_directory: this.cwd
      }
    };
  }
}

async function handleRunRequest(request: Request, env: Env): Promise<Response> {
  try {
    // Parse request body
    const body = (await request.json()) as { input?: string };
    const input = body.input;

    if (!input || typeof input !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid input field' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create shell (automatically collects results)
    const shell = new SandboxShell(
      env.Sandbox as unknown as DurableObjectNamespace<Sandbox>
    );

    // Create agent with auto-approval for web API
    const agent = new Agent({
      name: 'Shell Assistant',
      model: 'gpt-5.1',
      instructions:
        'You can execute shell commands to inspect the repository. Keep responses concise and include command output when helpful.',
      tools: [
        shellTool({
          shell,
          needsApproval: false // Auto-approve for web API
        })
      ]
    });

    // Run the agent
    const result = await run(agent, input);

    // Format response
    const response = {
      naturalResponse: result.finalOutput || null,
      toolResults: shell.results
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error: any) {
    console.error('❌ Error handling run request:', error);
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal server error',
        naturalResponse: 'An error occurred while processing your request.',
        toolResults: []
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run' && request.method === 'POST') {
      return handleRunRequest(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};
