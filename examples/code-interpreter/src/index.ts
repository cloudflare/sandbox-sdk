import OpenAI from 'openai';
import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const API_PATH = '/foo';
const MODEL = '@cf/openai/gpt-oss-120b';

type AIResponse = OpenAI.Responses.Response;
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;
type FunctionCall = OpenAI.Responses.ResponseFunctionToolCall;

interface SandboxResult {
	results?: Array<{ text?: string; html?: string; [key: string]: any }>;
	logs?: { stdout?: string[]; stderr?: string[] };
	error?: string;
}

async function callCloudflareAPI(
	env: Env,
	input: ResponseInputItem[],
	tools?: FunctionTool[],
	toolChoice: string = 'auto',
): Promise<AIResponse> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/responses`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${env.CLOUDFLARE_API_KEY}`,
		},
		body: JSON.stringify({
			model: MODEL,
			input,
			...(tools && { tools, tool_choice: toolChoice }),
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`API call failed: ${response.status} - ${errorText}`);
	}

	return response.json() as Promise<AIResponse>;
}

async function executePythonCode(env: Env, code: string): Promise<string> {
	const sandboxId = env.Sandbox.idFromName('default');
	const sandbox = getSandbox(env.Sandbox, sandboxId.toString());
	const pythonCtx = await sandbox.createCodeContext({ language: 'python' });
	const result = (await sandbox.runCode(code, { context: pythonCtx })) as SandboxResult;

	// Extract output from results (expressions)
	if (result.results?.length) {
		const outputs = result.results.map((r) => r.text || r.html || JSON.stringify(r)).filter(Boolean);
		if (outputs.length) return outputs.join('\n');
	}

	// Extract output from logs
	let output = '';
	if (result.logs?.stdout?.length) {
		output = result.logs.stdout.join('\n');
	}
	if (result.logs?.stderr?.length) {
		if (output) output += '\n';
		output += 'Error: ' + result.logs.stderr.join('\n');
	}

	return result.error ? `Error: ${result.error}` : output || 'Code executed successfully';
}

async function handleAIRequest(input: string, env: Env): Promise<string> {
	const pythonTool: FunctionTool = {
		type: 'function',
		name: 'execute_python',
		description: 'Execute Python code and return the output',
		parameters: {
			type: 'object',
			properties: {
				code: {
					type: 'string',
					description: 'The Python code to execute',
				},
			},
			required: ['code'],
		},
		strict: null,
	};

	// Initial AI request with Python execution tool
	let response = await callCloudflareAPI(env, [{ role: 'user', content: input }], [pythonTool]);

	// Check for function call
	const functionCall = response.output?.find(
		(item): item is FunctionCall => item.type === 'function_call' && item.name === 'execute_python',
	);

	if (functionCall?.arguments) {
		try {
			const { code } = JSON.parse(functionCall.arguments) as { code: string };
			const output = await executePythonCode(env, code);

			const functionResult: ResponseInputItem = {
				type: 'function_call_output',
				call_id: functionCall.call_id,
				output,
			} as OpenAI.Responses.ResponseInputItem.FunctionCallOutput;

			// Get final response with execution result
			response = await callCloudflareAPI(env, [{ role: 'user', content: input }, functionCall as ResponseInputItem, functionResult]);
		} catch (error) {
			console.error('Sandbox execution failed:', error);
		}
	}

	// Extract final response text
	const message = response.output?.find((item) => item.type === 'message');
	const text = message?.content?.find((c: any) => c.type === 'output_text')?.text;

	return text || 'No response generated';
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
			const message = error instanceof Error ? error.message : 'Internal Server Error';
			return Response.json({ error: message }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
