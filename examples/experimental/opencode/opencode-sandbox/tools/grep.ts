import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description: 'Search file contents in the sandbox using regular expressions.',
  args: {
    pattern: tool.schema.string().describe('Regex pattern to search for'),
    path: tool.schema
      .string()
      .optional()
      .describe('Directory or file to search in'),
    include: tool.schema
      .string()
      .optional()
      .describe("File glob pattern to filter files (e.g. '*.ts')"),
    literal_text: tool.schema
      .boolean()
      .optional()
      .describe('Treat pattern as literal text')
  },
  async execute(args, context) {
    const api = await getSandbox();
    const parts = ['rg', '--line-number', '--no-heading', '--color=never'];
    if (args.literal_text) parts.push('--fixed-strings');
    if (args.include) parts.push(`--glob='${args.include}'`);
    parts.push('--max-count=50');
    parts.push(`'${args.pattern.replace(/'/g, "'\\''")}'`);
    parts.push(args.path || '.');

    const result = await api.sandbox(context.sessionID).exec(parts.join(' '));
    if (result.exitCode === 1 && !result.stderr)
      return `No matches found for pattern: ${args.pattern}`;
    if (result.exitCode > 1) return `Search error: ${result.stderr}`;
    return result.stdout.trim() || 'No matches found';
  }
});
