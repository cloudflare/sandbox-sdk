const BASH_PATH = '/bin/bash';
const DEFAULT_CWD = '/workspace';
const TIMEOUT_EXIT_CODE = 124;
const KILL_GRACE_PERIOD_MS = 5_000;
const FORCE_KILL_WAIT_MS = 1_000;

export type StatelessCommandExecOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type StatelessCommandExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type SpawnedProcess = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export class StatelessCommandRunner {
  async exec(
    command: string,
    options: StatelessCommandExecOptions = {}
  ): Promise<StatelessCommandExecResult> {
    const spawned = spawnProcess(command, options);
    const stdoutPromise = readStreamText(spawned.stdout);
    const stderrPromise = readStreamText(spawned.stderr);
    const completion = await waitForProcessCompletion(
      spawned,
      options.timeoutMs
    );
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    return {
      exitCode: completion.exitCode,
      stdout,
      stderr: completion.timedOut
        ? appendLine(stderr, `Command timed out after ${options.timeoutMs}ms`)
        : stderr,
      timedOut: completion.timedOut
    };
  }
}

function spawnProcess(
  command: string,
  options: StatelessCommandExecOptions
): SpawnedProcess {
  return Bun.spawn([BASH_PATH, '-c', command], {
    cwd: options.cwd ?? DEFAULT_CWD,
    env: buildEnv(options.env),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true
  });
}

function buildEnv(
  env?: Record<string, string | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}

async function waitForProcessCompletion(
  spawned: SpawnedProcess,
  timeoutMs?: number
): Promise<{ exitCode: number; timedOut: boolean }> {
  if (timeoutMs === undefined) {
    return { exitCode: await spawned.exited, timedOut: false };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const exitCode = await Promise.race<number>([
      spawned.exited,
      new Promise<number>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return { exitCode, timedOut: false };
  } catch (error) {
    if (!timedOut) {
      throw error;
    }

    await terminateProcessTree(spawned.pid);
    await spawned.exited.catch(() => {});

    return {
      exitCode: TIMEOUT_EXIT_CODE,
      timedOut: true
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  killProcessGroup(pid, 'SIGTERM');

  if (await waitForProcessTreeExit(pid, KILL_GRACE_PERIOD_MS)) {
    return;
  }

  killProcessGroup(pid, 'SIGKILL');
  await waitForProcessTreeExit(pid, FORCE_KILL_WAIT_MS);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      throw error;
    }
  }
}

async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await processTreeExists(pid))) {
      return true;
    }
    await Bun.sleep(50);
  }

  return !(await processTreeExists(pid));
}

async function processTreeExists(pid: number): Promise<boolean> {
  if (processExists(pid)) {
    return true;
  }

  const children = await childPIDs(pid);
  return children.length > 0;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function childPIDs(pid: number): Promise<number[]> {
  const proc = Bun.spawn(['ps', '-o', 'pid=', '--ppid', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((childPid) => Number.isInteger(childPid));
}

async function readStreamText(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) {
    return '';
  }

  return new Response(stream).text();
}

function appendLine(value: string, line: string): string {
  return value.endsWith('\n') || value.length === 0
    ? `${value}${line}\n`
    : `${value}\n${line}\n`;
}
