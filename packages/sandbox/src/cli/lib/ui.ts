/**
 * Terminal UI utilities
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

export function bold(text: string): string {
  return `${colors.bold}${text}${colors.reset}`;
}

export function dim(text: string): string {
  return `${colors.dim}${text}${colors.reset}`;
}

export function red(text: string): string {
  return `${colors.red}${text}${colors.reset}`;
}

export function green(text: string): string {
  return `${colors.green}${text}${colors.reset}`;
}

export function yellow(text: string): string {
  return `${colors.yellow}${text}${colors.reset}`;
}

export function blue(text: string): string {
  return `${colors.blue}${text}${colors.reset}`;
}

export function cyan(text: string): string {
  return `${colors.cyan}${text}${colors.reset}`;
}

export function success(message: string): void {
  console.log(`${green('✓')} ${message}`);
}

export function error(message: string): void {
  console.error(`${red('✗')} ${message}`);
}

export function warn(message: string): void {
  console.log(`${yellow('!')} ${message}`);
}

export function info(message: string): void {
  console.log(`${blue('i')} ${message}`);
}

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  stop: (message?: string) => void;
  fail: (message?: string) => void;
}

export function spinner(message: string): Spinner {
  let frameIndex = 0;
  let stopped = false;

  const interval = setInterval(() => {
    if (stopped) return;
    process.stdout.write(`\r${cyan(spinnerFrames[frameIndex])} ${message}`);
    frameIndex = (frameIndex + 1) % spinnerFrames.length;
  }, 80);

  return {
    stop: (finalMessage?: string) => {
      stopped = true;
      clearInterval(interval);
      process.stdout.write(`\r${green('✓')} ${finalMessage || message}\n`);
    },
    fail: (finalMessage?: string) => {
      stopped = true;
      clearInterval(interval);
      process.stdout.write(`\r${red('✗')} ${finalMessage || message}\n`);
    }
  };
}
