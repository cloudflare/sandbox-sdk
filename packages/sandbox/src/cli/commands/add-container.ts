/**
 * Add a container configuration to a deployed worker
 */
import { parseArgs } from 'node:util';
import { getWorkerConfig, saveWorkerConfig } from '../lib/config.js';
import { error, info, success } from '../lib/ui.js';

export async function addContainer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      image: { type: 'string', short: 'i' },
      binding: { type: 'string', short: 'b' },
      default: { type: 'boolean', short: 'd' }
    }
  });

  const workerName = values.name;
  if (!workerName) {
    error('Worker name is required. Use --name or -n to specify.');
    process.exit(1);
  }

  const image = values.image;
  if (!image) {
    error('Container image is required. Use --image or -i to specify.');
    process.exit(1);
  }

  const config = await getWorkerConfig(workerName);
  if (!config) {
    error(`Worker "${workerName}" not found. Run "sandbox deploy" first.`);
    process.exit(1);
  }

  // Generate binding name from image if not provided
  const containerName = image.split('/').pop()?.split(':')[0] || 'container';
  const binding =
    values.binding ||
    `SANDBOX_${containerName.toUpperCase().replace(/-/g, '_')}`;

  // Check for duplicate bindings
  if (config.containers.some((c) => c.binding === binding)) {
    error(
      `Binding "${binding}" already exists. Use --binding to specify a different one.`
    );
    process.exit(1);
  }

  // Add container
  config.containers.push({
    name: containerName,
    image,
    binding,
    isDefault: values.default
  });

  // If this is the new default, remove default from others
  if (values.default) {
    for (const c of config.containers) {
      if (c.binding !== binding) {
        c.isDefault = false;
      }
    }
  }

  await saveWorkerConfig(config);

  success(`Container "${containerName}" added to "${workerName}"`);
  info(`Binding: ${binding}`);
  info(`Image: ${image}`);
  info('Note: You need to redeploy the worker for changes to take effect.');
  console.log(
    `  sandbox eject --name ${workerName} && cd .sandbox-${workerName} && npm run deploy`
  );
}
