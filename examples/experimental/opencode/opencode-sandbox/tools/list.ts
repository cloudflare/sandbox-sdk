import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description: 'List files and directories at a given path in the sandbox.',
  args: {
    path: tool.schema.string().optional().describe('Directory path to list')
  },
  async execute(args, context) {
    const api = await getSandbox();
    const dir = args.path || '.';
    const command = `ls -1Ap ${dir} 2>/dev/null | head -500`;
    const result = await api.sandbox(context.sessionID).exec(command);
    if (result.exitCode !== 0)
      return `Error: ${result.stderr || 'Directory not found'}`;
    return result.stdout.trim() || '(empty directory)';
  }
});
