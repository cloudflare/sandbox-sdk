/**
 * List containers in a deployed worker
 */
import { parseArgs } from 'node:util';
import { getWorkerConfig } from '../lib/config.js';
import { bold, dim, error } from '../lib/ui.js';

export async function listContainers(args: string[]): Promise<void> {
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
    console.log(JSON.stringify(config.containers, null, 2));
    return;
  }

  console.log(`\n${bold('Containers for')} ${workerName}:\n`);

  for (const container of config.containers) {
    const defaultTag = container.isDefault ? ` ${dim('(default)')}` : '';
    console.log(`  ${bold(container.name)}${defaultTag}`);
    console.log(`    Image:   ${container.image}`);
    console.log(`    Binding: ${container.binding}`);
    console.log();
  }
}
