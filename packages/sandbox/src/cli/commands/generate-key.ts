/**
 * Generate a new API key for a sandbox bridge
 */
import { parseArgs } from 'node:util';
import { generateApiKey, hashApiKey } from '../lib/api-key.js';
import { getWorkerConfig, saveWorkerConfig } from '../lib/config.js';
import { error, info, success, warn } from '../lib/ui.js';

export async function generateKey(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      'key-name': { type: 'string', short: 'k', default: 'default' }
    }
  });

  const workerName = values.name;
  if (!workerName) {
    error('Worker name is required. Use --name or -n to specify.');
    process.exit(1);
  }

  const config = await getWorkerConfig(workerName);
  if (!config) {
    error(`Worker "${workerName}" not found. Run "sandbox deploy" first.`);
    process.exit(1);
  }

  const keyName = values['key-name'] || 'default';

  // Check if key name already exists
  if (config.apiKeys.some((k) => k.name === keyName)) {
    error(
      `API key "${keyName}" already exists. Use --key-name to specify a different name.`
    );
    info(
      `To rotate an existing key, use: sandbox rotate-key --name ${workerName} --key-name ${keyName}`
    );
    process.exit(1);
  }

  // Generate new key
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);

  // Add to config
  config.apiKeys.push({
    name: keyName,
    keyHash,
    createdAt: new Date().toISOString()
  });

  await saveWorkerConfig(config);

  success(`API key generated for "${workerName}"`);
  console.log();
  console.log('  API Key (save this securely, it will not be shown again):');
  console.log(`  ${apiKey}`);
  console.log();
  warn('You need to update your worker environment with this key.');
  info('Run the following command to set the API key:');
  console.log(
    `  npx wrangler secret put SANDBOX_API_KEYS --name ${workerName}`
  );
  console.log();
  info('Enter the API key when prompted (or comma-separated list of keys).');
}
