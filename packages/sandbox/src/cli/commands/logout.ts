/**
 * Logout from Cloudflare
 */
import { parseArgs } from 'node:util';
import { saveConfig } from '../lib/config.js';
import { info, success } from '../lib/ui.js';
import { runWrangler } from '../lib/wrangler.js';

export async function logout(_args: string[]): Promise<void> {
  // Clear local config
  await saveConfig({});

  // Run wrangler logout
  await runWrangler(['logout']);

  success('Logged out from Cloudflare');
  info('Local configuration cleared.');
}
