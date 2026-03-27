import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description:
    'Read the contents of a file from the sandbox. Supports optional line range selection.',
  args: {
    filePath: tool.schema.string().describe('Path to the file to read'),
    startLine: tool.schema
      .number()
      .optional()
      .describe('Starting line number (1-indexed)'),
    endLine: tool.schema
      .number()
      .optional()
      .describe('Ending line number (1-indexed, inclusive)')
  },
  async execute(args, context) {
    const api = await getSandbox();
    const result = await api
      .sandbox(context.sessionID)
      .readFile(args.filePath, {
        startLine: args.startLine,
        endLine: args.endLine
      });
    let output = result.content;
    if (args.startLine || args.endLine) {
      output = `[Lines ${args.startLine ?? 1}-${args.endLine ?? 'end'}]\n${output}`;
    }
    return output;
  }
});
