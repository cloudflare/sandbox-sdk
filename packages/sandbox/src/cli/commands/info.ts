/**
 * Show info about a deployed sandbox bridge
 */
import { parseArgs } from 'node:util';
import { getWorkerConfig } from '../lib/config.js';
import { bold, dim, error } from '../lib/ui.js';

export async function info(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      json: { type: 'boolean' }
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

  if (values.json) {
    // Don't include sensitive data in JSON output
    const safeConfig = {
      ...config,
      apiKeys: config.apiKeys.map((k) => ({
        name: k.name,
        createdAt: k.createdAt
      }))
    };
    console.log(JSON.stringify(safeConfig, null, 2));
    return;
  }

  console.log(`\n${bold('Sandbox Bridge:')} ${config.name}\n`);
  console.log(`  Account ID:  ${config.accountId}`);
  console.log(`  Created:     ${config.createdAt}`);
  console.log(`  Containers:  ${config.containers.length}`);
  console.log(`  API Keys:    ${config.apiKeys.length}`);
  console.log();

  if (config.containers.length > 0) {
    console.log(`${bold('Containers:')}`);
    for (const container of config.containers) {
      const defaultTag = container.isDefault ? ` ${dim('(default)')}` : '';
      console.log(`  - ${container.name}${defaultTag}: ${container.image}`);
    }
    console.log();
  }

  if (config.apiKeys.length > 0) {
    console.log(`${bold('API Keys:')}`);
    for (const key of config.apiKeys) {
      console.log(`  - ${key.name} ${dim(`(created ${key.createdAt})`)}`);
    }
    console.log();
  }
}
