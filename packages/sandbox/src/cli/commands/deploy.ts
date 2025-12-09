/**
 * Deploy a new sandbox bridge worker
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type ContainerConfig,
  generatePackageJson,
  generateTsConfig,
  generateWorkerCode,
  generateWranglerToml,
  getConfig,
  runWrangler,
  saveWorkerConfig
} from '../lib/index.js';
import { error, info, spinner, success } from '../lib/ui.js';

export async function deploy(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', short: 'n' },
      'account-id': { type: 'string' },
      image: {
        type: 'string',
        short: 'i',
        default: 'cloudflare/sandbox:latest'
      },
      'output-dir': { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean' }
    }
  });

  const workerName = values.name;
  if (!workerName) {
    error('Worker name is required. Use --name or -n to specify.');
    process.exit(1);
  }

  // Get account ID
  let accountId = values['account-id'];
  if (!accountId) {
    const config = await getConfig();
    accountId = config.accountId;
  }

  if (!accountId) {
    error(
      'Account ID is required. Use --account-id or run "sandbox login" first.'
    );
    process.exit(1);
  }

  const outputDir = values['output-dir'] || `.sandbox-${workerName}`;
  const isDryRun = values['dry-run'];

  info(`Deploying sandbox bridge worker: ${workerName}`);

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create src directory
  const srcDir = join(outputDir, 'src');
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true });
  }

  // Default container configuration
  const containers: ContainerConfig[] = [
    {
      name: 'default',
      image: values.image || 'cloudflare/sandbox:latest',
      binding: 'SANDBOX',
      isDefault: true
    }
  ];

  // Generate files
  const wranglerToml = generateWranglerToml({
    workerName,
    containers,
    accountId
  });
  const workerCode = generateWorkerCode({
    workerName,
    containers,
    accountId
  });
  const packageJson = generatePackageJson(workerName);
  const tsConfig = generateTsConfig();

  // Write files
  writeFileSync(join(outputDir, 'wrangler.toml'), wranglerToml);
  writeFileSync(join(srcDir, 'index.ts'), workerCode);
  writeFileSync(join(outputDir, 'package.json'), packageJson);
  writeFileSync(join(outputDir, 'tsconfig.json'), tsConfig);

  if (isDryRun) {
    success('Dry run complete. Files generated in:');
    console.log(`  ${outputDir}/`);
    return;
  }

  // Install dependencies
  const installSpinner = spinner('Installing dependencies...');
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('npm', ['install'], {
      cwd: outputDir,
      stdio: 'ignore'
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed with code ${code}`));
    });
  });
  installSpinner.stop('Dependencies installed');

  // Deploy with wrangler
  const deploySpinner = spinner('Deploying to Cloudflare...');
  const result = await runWrangler(['deploy'], { cwd: outputDir });

  if (!result.success) {
    deploySpinner.fail('Deployment failed');
    error(result.stderr);
    process.exit(1);
  }

  deploySpinner.stop('Worker deployed');

  // Save worker config
  await saveWorkerConfig({
    name: workerName,
    accountId,
    createdAt: new Date().toISOString(),
    containers,
    apiKeys: []
  });

  success(`Sandbox bridge "${workerName}" deployed successfully!`);
  info('Next steps:');
  console.log(
    `  1. Generate an API key: sandbox generate-key --name ${workerName}`
  );
  console.log(
    `  2. Add more containers: sandbox add-container --name ${workerName} --image python:3.11`
  );
}
