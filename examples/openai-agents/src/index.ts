import { Sandbox, getSandbox } from '@cloudflare/sandbox';
import { Shell, Editor } from '@cloudflare/sandbox/openai';
export { Sandbox }; // export the Sandbox class for the worker

import { Agent, run, shellTool, applyPatchTool } from '@openai/agents';

// Helper functions for error handling
function isErrorWithProperties(error: unknown): error is {
  message?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  status?: number;
  stack?: string;
} {
  return typeof error === 'object' && error !== null;
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithProperties(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  if (isErrorWithProperties(error) && typeof error.stack === 'string') {
    return error.stack;
  }
  return undefined;
}

async function handleRunRequest(request: Request, env: Env): Promise<Response> {
  console.debug('[openai-example]', 'handleRunRequest called', {
    method: request.method,
    url: request.url
  });

  try {
    // Parse request body
    console.debug('[openai-example]', 'Parsing request body');
    const body = (await request.json()) as { input?: string };
    const input = body.input;

    if (!input || typeof input !== 'string') {
      console.warn('[openai-example]', 'Invalid or missing input field', {
        input
      });
      return new Response(
        JSON.stringify({ error: 'Missing or invalid input field' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.info('[openai-example]', 'Processing request', {
      inputLength: input.length
    });

    // Get sandbox instance (reused for both shell and editor)
    console.debug('[openai-example]', 'Getting sandbox instance', {
      sessionId: 'workspace-session'
    });
    const sandbox = getSandbox(env.Sandbox, 'workspace-session');

    // Create shell (automatically collects results)
    console.debug('[openai-example]', 'Creating SandboxShell');
    const shell = new Shell(sandbox);

    // Create workspace editor
    console.debug('[openai-example]', 'Creating WorkspaceEditor', {
      root: '/workspace'
    });
    const editor = new Editor(sandbox, '/workspace');

    // Create agent with both shell and patch tools, auto-approval for web API
    console.debug('[openai-example]', 'Creating Agent', {
      name: 'Sandbox Studio',
      model: 'gpt-5.1'
    });
    const agent = new Agent({
      name: 'Sandbox Studio',
      model: 'gpt-5.1',
      instructions:
        'You can execute shell commands and edit files in the workspace. Use shell commands to inspect the repository and the apply_patch tool to create, update, or delete files. Keep responses concise and include command output when helpful.',
      tools: [
        shellTool({
          shell,
          needsApproval: false // Auto-approve for web API
        }),
        applyPatchTool({
          editor,
          needsApproval: false // Auto-approve for web API
        })
      ]
    });

    // Run the agent
    console.info('[openai-example]', 'Running agent', { input });
    const result = await run(agent, input);
    console.debug('[openai-example]', 'Agent run completed', {
      hasOutput: !!result.finalOutput,
      outputLength: result.finalOutput?.length || 0
    });

    // Combine and sort all results by timestamp for logging
    const allResults = [
      ...shell.results.map((r) => ({ type: 'command' as const, ...r })),
      ...editor.results.map((r) => ({ type: 'file' as const, ...r }))
    ].sort((a, b) => a.timestamp - b.timestamp);

    console.debug('[openai-example]', 'Results collected', {
      commandResults: shell.results.length,
      fileOperations: editor.results.length,
      totalResults: allResults.length
    });

    // Format response with combined and sorted results
    const response = {
      naturalResponse: result.finalOutput || null,
      commandResults: shell.results.sort((a, b) => a.timestamp - b.timestamp),
      fileOperations: editor.results.sort((a, b) => a.timestamp - b.timestamp)
    };

    console.info('[openai-example]', 'Request completed successfully');
    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    const errorStack = getErrorStack(error);
    console.error('[openai-example]', 'Error handling run request', {
      error: errorMessage,
      stack: errorStack
    });
    return new Response(
      JSON.stringify({
        error: errorMessage || 'Internal server error',
        naturalResponse: 'An error occurred while processing your request.',
        commandResults: [],
        fileOperations: []
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
    console.debug('[openai-example]', 'Fetch handler called', {
      pathname: url.pathname,
      method: request.method
    });

    if (url.pathname === '/run' && request.method === 'POST') {
      return handleRunRequest(request, env);
    }

    console.warn('[openai-example]', 'Route not found', {
      pathname: url.pathname,
      method: request.method
    });
    return new Response('Not found', { status: 404 });
  }
};
