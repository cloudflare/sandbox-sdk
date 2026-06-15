import { Buffer } from 'node:buffer';
import { closeSync, writeSync } from 'node:fs';

const RETRY_DELAY_MS = 1;

type ErrnoError = Error & { code?: string };

export class CommandChannel {
  private closed = false;

  constructor(private readonly fd: number) {}

  async write(frame: string): Promise<void> {
    if (this.closed) {
      throw new Error('Command channel is closed');
    }

    const bytes = Buffer.from(frame);
    let offset = 0;

    while (offset < bytes.length) {
      try {
        offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        if (isRetryableWriteError(error)) {
          await Bun.sleep(RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeFileDescriptor(this.fd);
  }
}

export function closeSubprocessStdioFd(
  subprocess: Bun.Subprocess,
  fdNumber: number
): void {
  const fd = subprocess.stdio[fdNumber];
  if (typeof fd === 'number') {
    closeFileDescriptor(fd);
  }
}

export function getSubprocessStdioFd(
  subprocess: Bun.Subprocess,
  fdNumber: number
): number {
  const fd = subprocess.stdio[fdNumber];
  if (typeof fd !== 'number') {
    throw new Error(`Expected subprocess stdio fd ${fdNumber} to be exposed`);
  }
  return fd;
}

function closeFileDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {}
}

function isRetryableWriteError(error: unknown): error is ErrnoError {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }
  const code = (error as ErrnoError).code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR';
}
