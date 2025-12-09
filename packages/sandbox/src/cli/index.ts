#!/usr/bin/env node
/**
 * Cloudflare Sandbox CLI
 *
 * A CLI tool for deploying and managing sandboxed code execution environments.
 */
import { parseArgs } from 'node:util';

const commands = [
  'deploy',
  'add-container',
  'list-containers',
  'info',
  'list',
  'delete',
  'generate-key',
  'rotate-key',
  'eject',
  'login',
  'logout',
  'help'
] as const;

type Command = (typeof commands)[number];

function printHelp() {
  console.log(`
Cloudflare Sandbox CLI

Usage: sandbox <command> [options]

Commands:
  deploy              Deploy a new sandbox bridge worker
  add-container       Add a container configuration to the worker
  list-containers     List containers in the deployed worker
  info                Show info about a deployed sandbox bridge
  list                List all deployed sandbox bridges
  delete              Delete a deployed sandbox bridge
  generate-key        Generate a new API key
  rotate-key          Rotate an existing API key
  eject               Eject the worker code for manual customization
  login               Login to Cloudflare
  logout              Logout from Cloudflare

Options:
  -h, --help          Show this help message
  -v, --version       Show version

Examples:
  sandbox deploy --name my-sandbox
  sandbox add-container --name python --image python:3.11
  sandbox generate-key --name my-sandbox
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (
    args.length === 0 ||
    args[0] === 'help' ||
    args[0] === '--help' ||
    args[0] === '-h'
  ) {
    printHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    // Lazy-load version
    const { SDK_VERSION } = await import('../version.js');
    console.log(`sandbox ${SDK_VERSION}`);
    process.exit(0);
  }

  const command = args[0] as Command;

  if (!commands.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "sandbox help" for usage information.');
    process.exit(1);
  }

  // Parse remaining args for the command
  const commandArgs = args.slice(1);

  try {
    // Lazy-load commands for faster startup
    switch (command) {
      case 'deploy': {
        const { deploy } = await import('./commands/deploy.js');
        await deploy(commandArgs);
        break;
      }
      case 'add-container': {
        const { addContainer } = await import('./commands/add-container.js');
        await addContainer(commandArgs);
        break;
      }
      case 'list-containers': {
        const { listContainers } = await import(
          './commands/list-containers.js'
        );
        await listContainers(commandArgs);
        break;
      }
      case 'info': {
        const { info } = await import('./commands/info.js');
        await info(commandArgs);
        break;
      }
      case 'list': {
        const { list } = await import('./commands/list.js');
        await list(commandArgs);
        break;
      }
      case 'delete': {
        const { deleteCommand } = await import('./commands/delete.js');
        await deleteCommand(commandArgs);
        break;
      }
      case 'generate-key': {
        const { generateKey } = await import('./commands/generate-key.js');
        await generateKey(commandArgs);
        break;
      }
      case 'rotate-key': {
        const { rotateKey } = await import('./commands/rotate-key.js');
        await rotateKey(commandArgs);
        break;
      }
      case 'eject': {
        const { eject } = await import('./commands/eject.js');
        await eject(commandArgs);
        break;
      }
      case 'login': {
        const { login } = await import('./commands/login.js');
        await login(commandArgs);
        break;
      }
      case 'logout': {
        const { logout } = await import('./commands/logout.js');
        await logout(commandArgs);
        break;
      }
      case 'help':
        printHelp();
        break;
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('An unexpected error occurred');
    }
    process.exit(1);
  }
}

main();
