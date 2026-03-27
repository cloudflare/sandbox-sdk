import { tool } from '@opencode-ai/plugin';
import { getSandbox } from '../cloudflare-sandbox/rpc';

export default tool({
  description: 'Find files in the sandbox matching a glob pattern.',
  args: {
    pattern: tool.schema
      .string()
      .describe("Glob pattern to match files (e.g. '**/*.ts')"),
    path: tool.schema.string().optional().describe('Directory to search in')
  },
  async execute(args, context) {
    const api = await getSandbox();
    const dir = args.path || '.';
    const command = `find ${dir} -path '${args.pattern}' -type f 2>/dev/null | head -200 | sort`;
    const result = await api.sandbox(context.sessionID).exec(command);
    return (
      result.stdout.trim() || `No files found matching pattern: ${args.pattern}`
    );
  }
});
