/**
 * Wrangler CLI wrapper
 *
 * Provides utilities for interacting with the wrangler CLI.
 */
import { spawn } from 'node:child_process';

export interface WranglerResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runWrangler(
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): Promise<WranglerResult> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['wrangler', ...args], {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });

    proc.on('error', (error) => {
      resolve({
        success: false,
        stdout,
        stderr: error.message,
        exitCode: 1
      });
    });
  });
}

export async function checkWranglerAuth(): Promise<boolean> {
  const result = await runWrangler(['whoami']);
  return result.success;
}

export async function getAccountId(): Promise<string | null> {
  const result = await runWrangler(['whoami', '--json']);
  if (!result.success) return null;

  try {
    const data = JSON.parse(result.stdout);
    return data.account?.id || null;
  } catch {
    return null;
  }
}
