/**
 * List all deployed sandbox bridges
 */
import { parseArgs } from 'node:util';
import { listWorkerConfigs } from '../lib/config.js';
import { bold, dim, info } from '../lib/ui.js';

export async function list(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' }
    }
  });

  const configs = await listWorkerConfigs();

  if (values.json) {
    // Don't include sensitive data
    const safeConfigs = configs.map((c) => ({
      name: c.name,
      accountId: c.accountId,
      createdAt: c.createdAt,
      containers: c.containers.length,
      apiKeys: c.apiKeys.length
    }));
    console.log(JSON.stringify(safeConfigs, null, 2));
    return;
  }

  if (configs.length === 0) {
    info('No sandbox bridges found. Run "sandbox deploy" to create one.');
    return;
  }

  console.log(`\n${bold('Sandbox Bridges:')}\n`);

  for (const config of configs) {
    console.log(`  ${bold(config.name)}`);
    console.log(`    Account:    ${config.accountId}`);
    console.log(`    Created:    ${dim(config.createdAt)}`);
    console.log(`    Containers: ${config.containers.length}`);
    console.log(`    API Keys:   ${config.apiKeys.length}`);
    console.log();
  }
}
