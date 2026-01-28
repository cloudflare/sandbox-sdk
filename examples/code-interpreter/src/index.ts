import { getSandbox } from '@cloudflare/sandbox';
import { generateText, stepCountIs, tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';

export { Sandbox } from '@cloudflare/sandbox';

const API_PATH = '/run';
const MODEL = '@cf/openai/gpt-oss-120b' as const;

async function executePythonCode(env: Env, code: string): Promise<string> {
  const sandboxId = env.Sandbox.idFromName('default');
  const sandbox = getSandbox(env.Sandbox, sandboxId.toString().slice(0, 63));
  const pythonCtx = await sandbox.createCodeContext({ language: 'python' });
  const result = await sandbox.runCode(code, {
    context: pythonCtx
  });

  // Extract output from results (expressions)
  if (result.results?.length) {
    const outputs = result.results
      .map((r) => r.text || r.html || JSON.stringify(r))
      .filter(Boolean);
    if (outputs.length) return outputs.join('\n');
  }

  // Extract output from logs
  let output = '';
  if (result.logs?.stdout?.length) {
    output = result.logs.stdout.join('\n');
  }
  if (result.logs?.stderr?.length) {
    if (output) output += '\n';
    output += `Error: ${result.logs.stderr.join('\n')}`;
  }

  return result.error
    ? `Error: ${result.error}`
    : output || 'Code executed successfully';
}

async function handleAIRequest(input: string, env: Env): Promise<string> {
  const workersai = createWorkersAI({ binding: env.AI });

  const result = await generateText({
    // @ts-expect-error - gpt-oss-120b is a valid Workers AI model but not yet in the type definitions
    model: workersai(MODEL),
    messages: [{ role: 'user', content: input }],
    tools: {
      execute_python: tool({
        description: 'Execute Python code and return the output',
        inputSchema: z.object({
          code: z.string().describe('The Python code to execute')
        }),
        execute: async ({ code }) => {
          return executePythonCode(env, code);
        }
      })
    },
    stopWhen: stepCountIs(5)
  });

  return result.text || 'No response generated';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== API_PATH || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const { input } = await request.json<{ input?: string }>();

      if (!input) {
        return Response.json({ error: 'Missing input field' }, { status: 400 });
      }

      const output = await handleAIRequest(input, env);
      return Response.json({ output });
    } catch (error) {
      console.error('Request failed:', error);
      const message =
        error instanceof Error ? error.message : 'Internal Server Error';
      return Response.json({ error: message }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;
