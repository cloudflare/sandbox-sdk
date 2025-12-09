/**
 * Eject the worker code for manual customization
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getWorkerConfig } from '../lib/config.js';
import {
  generatePackageJson,
  generateTsConfig,
  generateWorkerCode,
  generateWranglerToml
} from '../lib/templates.js';
import { dim, error, info, success } from '../lib/ui.js';

export async function eject(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      'output-dir': { type: 'string', short: 'o' },
      force: { type: 'boolean', short: 'f' }
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

  const outputDir = values['output-dir'] || `.sandbox-${workerName}`;

  if (existsSync(outputDir) && !values.force) {
    error(
      `Output directory "${outputDir}" already exists. Use --force to overwrite.`
    );
    process.exit(1);
  }

  // Create directories
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'src'), { recursive: true });

  // Generate files
  const wranglerToml = generateWranglerToml({
    workerName: config.name,
    containers: config.containers,
    accountId: config.accountId
  });
  const workerCode = generateWorkerCode({
    workerName: config.name,
    containers: config.containers,
    accountId: config.accountId
  });
  const packageJson = generatePackageJson(config.name);
  const tsConfig = generateTsConfig();

  // Write files
  writeFileSync(join(outputDir, 'wrangler.toml'), wranglerToml);
  writeFileSync(join(outputDir, 'src', 'index.ts'), workerCode);
  writeFileSync(join(outputDir, 'package.json'), packageJson);
  writeFileSync(join(outputDir, 'tsconfig.json'), tsConfig);

  success(`Worker code ejected to:`);
  console.log(`  ${dim(`${outputDir}/`)}`);
  console.log();
  info('Next steps:');
  console.log(`  1. cd ${outputDir}`);
  console.log('  2. npm install');
  console.log('  3. Edit src/index.ts to customize');
  console.log('  4. npm run deploy');
}
