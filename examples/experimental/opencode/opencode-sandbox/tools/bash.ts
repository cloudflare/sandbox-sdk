import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description:
    'Execute a bash command in the sandbox environment. Use this for running shell commands, scripts, and system operations.',
  args: {
    command: tool.schema.string().describe('The bash command to execute'),
    timeout: tool.schema.number().optional().describe('Timeout in milliseconds')
  },
  async execute(args, context) {
    console.log('[tool] bash');
    const api = await getSandbox();
    const result = await api
      .sandbox(context.sessionID)
      .exec(args.command, { timeout: args.timeout });

    let output = '';
    if (result.stdout) output += result.stdout;
    if (result.stderr)
      output += `${output ? '\n' : ''}stderr: ${result.stderr}`;
    if (result.exitCode !== 0)
      output += `${output ? '\n' : ''}exit code: ${result.exitCode}`;
    return output || '(no output)';
  }
});
