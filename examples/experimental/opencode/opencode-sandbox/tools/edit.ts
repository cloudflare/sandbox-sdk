import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description:
    'Edit a file in the sandbox by replacing an exact string match with new content.',
  args: {
    filePath: tool.schema.string().describe('Path to the file to edit'),
    oldText: tool.schema
      .string()
      .describe('Exact text to find and replace (must match exactly)'),
    newText: tool.schema
      .string()
      .describe('New text to replace the old text with')
  },
  async execute(args, context) {
    const api = await getSandbox();

    const file = await api.sandbox(context.sessionID).readFile(args.filePath);
    const content: string = file.content;

    if (!content.includes(args.oldText)) {
      return `Error: Could not find the exact text to replace in ${args.filePath}.`;
    }
    const occurrences = content.split(args.oldText).length - 1;
    if (occurrences > 1) {
      return `Error: Found ${occurrences} matches in ${args.filePath}. Add more context to make it unique.`;
    }

    const newContent = content.replace(args.oldText, args.newText);
    await api.sandbox(context.sessionID).writeFile(args.filePath, newContent);
    return `Successfully edited ${args.filePath}`;
  }
});
