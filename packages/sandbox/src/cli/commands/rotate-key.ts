/**
 * Rotate an existing API key
 */
import { parseArgs } from 'node:util';
import { generateApiKey, hashApiKey } from '../lib/api-key.js';
import { getWorkerConfig, saveWorkerConfig } from '../lib/config.js';
import { error, info, success, warn } from '../lib/ui.js';

export async function rotateKey(args: string[]): Promise<void> {
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

  // Find existing key
  const keyIndex = config.apiKeys.findIndex((k) => k.name === keyName);
  if (keyIndex === -1) {
    error(`API key "${keyName}" not found.`);
    info(
      `Available keys: ${config.apiKeys.map((k) => k.name).join(', ') || 'none'}`
    );
    process.exit(1);
  }

  // Generate new key
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);

  // Update config
  config.apiKeys[keyIndex] = {
    name: keyName,
    keyHash,
    createdAt: new Date().toISOString()
  };

  await saveWorkerConfig(config);

  success(`API key "${keyName}" rotated for "${workerName}"`);
  console.log();
  console.log(
    '  New API Key (save this securely, it will not be shown again):'
  );
  console.log(`  ${apiKey}`);
  console.log();
  warn('You need to update your worker environment with this new key.');
  info('Run the following command to update the API key:');
  console.log(
    `  npx wrangler secret put SANDBOX_API_KEYS --name ${workerName}`
  );
  console.log();
  info(
    'Enter the new API key when prompted (or comma-separated list of keys).'
  );
}
