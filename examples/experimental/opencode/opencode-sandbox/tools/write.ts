import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description:
    'Create a new file or overwrite an existing file in the sandbox.',
  args: {
    filePath: tool.schema.string().describe('Path to the file to write'),
    content: tool.schema.string().describe('Content to write to the file')
  },
  async execute(args, context) {
    const api = await getSandbox();
    await api.sandbox(context.sessionID).writeFile(args.filePath, args.content);
    return `Successfully wrote ${args.content.length} characters to ${args.filePath}`;
  }
});
