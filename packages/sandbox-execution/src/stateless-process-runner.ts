const BASH_PATH = '/bin/bash';
const DEFAULT_CWD = '/workspace';
const TIMEOUT_EXIT_CODE = 124;
const KILL_GRACE_PERIOD_MS = 5_000;
const FORCE_KILL_WAIT_MS = 1_000;

export type StdioChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
  seq: number;
};

export type StatelessProcessStartOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onOutput?: (chunk: StdioChunk) => void | Promise<void>;
};

export type StatelessProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: StdioChunk[];
  timedOut: boolean;
};

type SpawnedProcess = {
  pid: number;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

type OutputCollector = {
  output: StdioChunk[];
  nextSeq: number;
};

export class StatelessProcess {
  constructor(
    readonly pid: number,
    private readonly completion: Promise<StatelessProcessResult>
  ) {}

  wait(): Promise<StatelessProcessResult> {
    return this.completion;
  }

  async kill(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    await killProcessTree(this.pid, signal);
  }
}

export class StatelessProcessRunner {
  start(
    command: string,
    options: StatelessProcessStartOptions = {}
  ): StatelessProcess {
    const spawned = spawnProcess(command, options);
    const completion = collectProcess(spawned, options);

    return new StatelessProcess(spawned.pid, completion);
  }
}

function spawnProcess(
  command: string,
  options: StatelessProcessStartOptions
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

async function collectProcess(
  spawned: SpawnedProcess,
  options: StatelessProcessStartOptions
): Promise<StatelessProcessResult> {
  const collector: OutputCollector = { output: [], nextSeq: 0 };
  const stdoutPromise = pipeStreamToOutput(
    spawned.stdout,
    'stdout',
    collector,
    options.onOutput
  );
  const stderrPromise = pipeStreamToOutput(
    spawned.stderr,
    'stderr',
    collector,
    options.onOutput
  );

  const completion = await waitForProcessCompletion(spawned, options.timeoutMs);
  await Promise.all([stdoutPromise, stderrPromise]);

  if (completion.timedOut) {
    await recordOutput(
      collector,
      'stderr',
      `Command timed out after ${options.timeoutMs}ms\n`,
      options.onOutput
    );
  }

  return {
    exitCode: completion.exitCode,
    stdout: collectOutput(collector.output, 'stdout'),
    stderr: collectOutput(collector.output, 'stderr'),
    output: collector.output,
    timedOut: completion.timedOut
  };
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
  await killProcessTree(pid, 'SIGTERM');

  if (await waitForProcessTreeExit(pid, KILL_GRACE_PERIOD_MS)) {
    return;
  }

  await killProcessTree(pid, 'SIGKILL');
  await waitForProcessTreeExit(pid, FORCE_KILL_WAIT_MS);
}

async function killProcessTree(
  pid: number,
  signal: NodeJS.Signals
): Promise<void> {
  killProcessGroup(pid, signal);

  for (const childPID of await childPIDs(pid)) {
    await killProcessTree(childPID, signal);
  }
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
  const output = proc.stdout ? await new Response(proc.stdout).text() : '';
  await proc.exited;

  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((childPID) => Number.isInteger(childPID) && childPID > 0);
}

async function pipeStreamToOutput(
  stream: ReadableStream<Uint8Array> | null,
  type: StdioChunk['stream'],
  collector: OutputCollector,
  onOutput?: (chunk: StdioChunk) => void | Promise<void>
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const remaining = decoder.decode();
        if (remaining.length > 0) {
          await recordOutput(collector, type, remaining, onOutput);
        }
        return;
      }

      const chunk = decoder.decode(value, { stream: true });
      if (chunk.length > 0) {
        await recordOutput(collector, type, chunk, onOutput);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function recordOutput(
  collector: OutputCollector,
  stream: StdioChunk['stream'],
  data: string,
  onOutput?: (chunk: StdioChunk) => void | Promise<void>
): Promise<void> {
  const chunk: StdioChunk = {
    stream,
    data,
    seq: collector.nextSeq++
  };
  collector.output.push(chunk);
  await onOutput?.(chunk);
}

function collectOutput(
  output: StdioChunk[],
  stream: StdioChunk['stream']
): string {
  return output
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join('');
}
