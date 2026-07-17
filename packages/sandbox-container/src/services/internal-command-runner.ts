import { signalProcessTree } from '@repo/sandbox-execution';
import type { InternalCommandResult } from './internal-command-result';

const DEFAULT_CWD = '/workspace';
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_TERMINATION_GRACE_MS = 1_000;

export interface InternalCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class InternalCommandRunner {
  async run(
    command: string,
    options: InternalCommandOptions = {}
  ): Promise<InternalCommandResult> {
    const start = Date.now();
    const proc = Bun.spawn(['/bin/bash', '-lc', command], {
      cwd: options.cwd ?? DEFAULT_CWD,
      env: this.buildEnv(options.env),
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const exitCode = await this.waitWithTimeout(proc, options.timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);

    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr:
        exitCode === TIMEOUT_EXIT_CODE && options.timeoutMs !== undefined
          ? `${stderr}Command timed out after ${options.timeoutMs}ms\n`
          : stderr,
      command,
      duration: Date.now() - start,
      timestamp: new Date(start).toISOString()
    };
  }

  private buildEnv(
    env?: Record<string, string | undefined>
  ): Record<string, string> {
    // Internal operations intentionally inherit the complete container
    // environment and apply operation-specific values as an overlay.
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[key] = value;
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }

  private async waitWithTimeout(
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    timeoutMs?: number
  ): Promise<number> {
    if (timeoutMs === undefined) return proc.exited;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      proc.exited.then((exitCode) => ({ timedOut: false as const, exitCode })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!outcome.timedOut) return outcome.exitCode;

    await signalProcessTree(proc.pid, 15);
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        proc.exited,
        new Promise<void>((resolve) => {
          terminationGrace = setTimeout(resolve, TIMEOUT_TERMINATION_GRACE_MS);
        })
      ]);
    } finally {
      if (terminationGrace) clearTimeout(terminationGrace);
    }
    await signalProcessTree(proc.pid, 9);
    await proc.exited;
    return TIMEOUT_EXIT_CODE;
  }
}
