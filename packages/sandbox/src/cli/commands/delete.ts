/**
 * Delete a deployed sandbox bridge
 */
import { parseArgs } from 'node:util';
import { deleteWorkerConfig, getWorkerConfig } from '../lib/config.js';
import { error, info, spinner, success, warn } from '../lib/ui.js';
import { runWrangler } from '../lib/wrangler.js';

export async function deleteCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      force: { type: 'boolean', short: 'f' },
      'keep-remote': { type: 'boolean' }
    }
  });

  const workerName = values.name;
  if (!workerName) {
    error('Worker name is required. Use --name or -n to specify.');
    process.exit(1);
  }

  const config = await getWorkerConfig(workerName);
  if (!config) {
    error(`Worker "${workerName}" not found.`);
    process.exit(1);
  }

  if (!values.force) {
    warn(`This will delete the sandbox bridge "${workerName}".`);
    info('Use --force to confirm deletion.');
    process.exit(1);
  }

  // Delete from Cloudflare unless --keep-remote is specified
  if (!values['keep-remote']) {
    const deleteSpinner = spinner('Deleting worker from Cloudflare...');
    const result = await runWrangler([
      'delete',
      '--name',
      workerName,
      '--force'
    ]);

    if (!result.success) {
      deleteSpinner.fail('Failed to delete worker from Cloudflare');
      warn('Continuing with local config deletion...');
    } else {
      deleteSpinner.stop('Worker deleted from Cloudflare');
    }
  }

  // Delete local config
  await deleteWorkerConfig(workerName);
  success(`Sandbox bridge "${workerName}" deleted.`);
}
