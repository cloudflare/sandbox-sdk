import { validateSignal } from './signals';

export async function getDescendantPids(pid: number): Promise<number[]> {
  validatePid(pid);
  const text = await readProcessTable('pid=,ppid=');
  const children = new Map<number, number[]>();
  for (const line of text.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const child = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue;
    const entries = children.get(parent) ?? [];
    entries.push(child);
    children.set(parent, entries);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(pid) ?? [])];
  while (pending.length > 0) {
    const child = pending.pop();
    if (child === undefined) continue;
    descendants.push(child);
    pending.push(...(children.get(child) ?? []));
  }
  return descendants;
}

export function isProcessGroupRunning(pid: number): boolean {
  validatePid(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && isNoSuchProcess(error)) return false;
    if (error instanceof Error && isOperationNotPermitted(error)) return true;
    throw error;
  }
}

export function isPidRunning(pid: number): boolean {
  validatePid(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && isNoSuchProcess(error)) return false;
    if (error instanceof Error && isOperationNotPermitted(error)) return true;
    throw error;
  }
}

export async function signalProcessTree(
  pid: number,
  signal = 15
): Promise<void> {
  validatePid(pid);
  const validatedSignal = validateSignal(signal);
  try {
    process.kill(-pid, validatedSignal);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !isNoSuchProcess(error)) throw error;
    const descendants = await getDescendantPids(pid);
    for (const descendant of descendants.reverse()) {
      try {
        process.kill(descendant, validatedSignal);
      } catch (descendantError) {
        if (
          !(descendantError instanceof Error) ||
          !isNoSuchProcess(descendantError)
        )
          throw descendantError;
      }
    }
    try {
      process.kill(pid, validatedSignal);
    } catch (targetError) {
      if (!(targetError instanceof Error) || !isNoSuchProcess(targetError))
        throw targetError;
    }
  }
}

async function readProcessTable(columns: string): Promise<string> {
  const process = Bun.spawn(['ps', '-eo', columns], {
    stdout: 'pipe',
    stderr: 'ignore'
  });
  const text = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) return '';
  return text;
}

function isNoSuchProcess(error: object): boolean {
  return 'code' in error && error.code === 'ESRCH';
}

function isOperationNotPermitted(error: object): boolean {
  return 'code' in error && error.code === 'EPERM';
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('PID must be a positive safe integer');
  }
}
