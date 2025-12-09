/**
 * Login to Cloudflare
 */
import { parseArgs } from 'node:util';
import { saveConfig } from '../lib/config.js';
import { error, info, spinner, success } from '../lib/ui.js';
import { getAccountId, runWrangler } from '../lib/wrangler.js';

export async function login(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'account-id': { type: 'string' }
    }
  });

  // If account-id provided directly, just save it
  if (values['account-id']) {
    await saveConfig({ accountId: values['account-id'] });
    success(`Account ID saved: ${values['account-id']}`);
    return;
  }

  // Otherwise, run wrangler login
  info('Opening browser for Cloudflare login...');

  const result = await runWrangler(['login']);

  if (!result.success) {
    error('Login failed');
    console.error(result.stderr);
    process.exit(1);
  }

  // Get account ID
  const accountSpinner = spinner('Fetching account info...');
  const accountId = await getAccountId();

  if (accountId) {
    await saveConfig({ accountId });
    accountSpinner.stop(`Logged in. Account ID: ${accountId}`);
  } else {
    accountSpinner.fail('Could not determine account ID');
    info(
      'You can set it manually with: sandbox login --account-id YOUR_ACCOUNT_ID'
    );
  }
}
