import type {
  PortWatchEvent,
  ProcessExit,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessOutput,
  ProcessOutputOptions,
  ProcessStatus,
  ProcessTextOutputOptions,
  SandboxProcess,
  WaitForLogOptions,
  WaitForLogResult,
  WaitForPortOptions
} from '@repo/shared';
import { readProcessOutput, validateMaxBytes } from './process-output';
import { waitForReadiness } from './process-readiness';
import {
  abortError,
  processFailure,
  streamClosed,
  withLocalWait
} from './process-waits';
import { openRemoteSubscription } from './remote-subscription';
import type { ProcessRPCDescriptor } from './rpc-types';
import { readUntilLogMatch } from './wait-for-log';

export type { SandboxProcess };

export class SandboxProcessImpl implements SandboxProcess {
  #exitCodePromise?: Promise<number>;

  constructor(
    readonly id: string,
    readonly pid: number,
    private readonly capability: ProcessRPCDescriptor['capability']
  ) {}

  get exitCode(): Promise<number> {
    this.#exitCodePromise ??= this.waitForExit().then((exit) => exit.code);
    return this.#exitCodePromise;
  }

  status(): Promise<ProcessStatus> {
    return this.capability.status();
  }

  async logs(
    options: ProcessLogsOptions = {}
  ): Promise<ReadableStream<ProcessLogEvent>> {
    const { signal, ...rpcOptions } = options;
    return openRemoteSubscription(this.capability.openLogs(rpcOptions), {
      signal,
      operation: 'read process logs',
      abortError:
        signal === undefined
          ? undefined
          : () => abortError(this.id, 'logs', signal)
    });
  }

  output(options: ProcessTextOutputOptions): Promise<ProcessOutput<string>>;
  output(options?: ProcessOutputOptions): Promise<ProcessOutput<Uint8Array>>;
  async output(
    options: ProcessOutputOptions | ProcessTextOutputOptions = {}
  ): Promise<ProcessOutput<Uint8Array> | ProcessOutput<string>> {
    const maxBytes = validateMaxBytes(options.maxBytes);
    const bytes = await withLocalWait(
      (settlementSignal) =>
        this.consumeLogs(settlementSignal, (reader) =>
          readProcessOutput(reader, {
            maxBytes,
            processId: this.id,
            pid: this.pid
          })
        ),
      {
        processId: this.id,
        operation: 'output',
        timeout: options.timeout,
        signal: options.signal
      }
    );
    if ('encoding' in options && options.encoding === 'utf8') {
      return {
        ...bytes,
        stdout: new TextDecoder().decode(bytes.stdout),
        stderr: new TextDecoder().decode(bytes.stderr)
      };
    }
    return bytes;
  }

  async waitForExit(
    options: { timeout?: number; signal?: AbortSignal } = {}
  ): Promise<ProcessExit> {
    return withLocalWait(
      (settlementSignal) =>
        this.consumeLogs(settlementSignal, (reader) =>
          readTerminal(reader, this.id, this.pid)
        ),
      {
        processId: this.id,
        operation: 'waitForExit',
        timeout: options.timeout,
        signal: options.signal
      }
    );
  }

  async waitForLog(
    pattern: string | RegExp,
    options: WaitForLogOptions = {}
  ): Promise<WaitForLogResult> {
    return withLocalWait(
      (settlementSignal) =>
        this.consumeLogs(settlementSignal, (reader) =>
          readUntilLogMatch(
            reader,
            pattern,
            options.stream ?? 'both',
            this.id,
            this.pid
          )
        ),
      {
        processId: this.id,
        operation: 'waitForLog',
        timeout: options.timeout,
        signal: options.signal
      }
    );
  }

  async waitForPort(
    port: number,
    options: WaitForPortOptions = {}
  ): Promise<void> {
    const { timeout, signal, ...rpcOptions } = options;
    return withLocalWait(
      (settlementSignal) =>
        this.waitForPortSubscriptions(port, rpcOptions, settlementSignal),
      {
        processId: this.id,
        operation: 'waitForPort',
        timeout,
        signal,
        port
      }
    );
  }

  private async waitForPortSubscriptions(
    port: number,
    options: Omit<WaitForPortOptions, 'timeout' | 'signal'>,
    settlementSignal: AbortSignal
  ): Promise<void> {
    const portStream = await openRemoteSubscription(
      this.capability.openPortWatch(port, options),
      { operation: `watch port ${port}`, signal: settlementSignal }
    );
    let logStream: ReadableStream<ProcessLogEvent> | undefined;
    let portReader: ReadableStreamDefaultReader<PortWatchEvent> | undefined;
    let logReader: ReadableStreamDefaultReader<ProcessLogEvent> | undefined;
    try {
      portReader = portStream.getReader();
      logStream = await openRemoteSubscription(
        this.capability.openLogs({ replay: true, follow: true }),
        { operation: 'read process logs', signal: settlementSignal }
      );
      logReader = logStream.getReader();
      await waitForReadiness(portReader, logReader, {
        processId: this.id,
        pid: this.pid,
        port
      });
    } finally {
      await cancelOwned(portReader, portStream);
      if (logStream !== undefined) await cancelOwned(logReader, logStream);
    }
  }

  kill(signal = 15): Promise<void> {
    return this.capability.kill(signal);
  }

  private async consumeLogs<T>(
    signal: AbortSignal,
    consume: (
      reader: ReadableStreamDefaultReader<ProcessLogEvent>
    ) => Promise<T>
  ): Promise<T> {
    const stream = await openRemoteSubscription(
      this.capability.openLogs({ replay: true, follow: true }),
      { signal, operation: 'read process logs' }
    );
    return this.consume(stream, consume);
  }

  private async consume<T>(
    stream: ReadableStream<ProcessLogEvent>,
    consume: (
      reader: ReadableStreamDefaultReader<ProcessLogEvent>
    ) => Promise<T>
  ): Promise<T> {
    let reader: ReadableStreamDefaultReader<ProcessLogEvent> | undefined;
    try {
      reader = stream.getReader();
      return await consume(reader);
    } finally {
      await cancelOwned(reader, stream);
    }
  }
}

export function createSandboxProcess(
  descriptor: ProcessRPCDescriptor
): SandboxProcess {
  return new SandboxProcessImpl(
    descriptor.id,
    descriptor.pid,
    descriptor.capability
  );
}

async function readTerminal(
  reader: ReadableStreamDefaultReader<ProcessLogEvent>,
  processId: string,
  pid: number
): Promise<ProcessExit> {
  for (;;) {
    const result = await reader.read();
    if (result.done) streamClosed('Process log stream ended before exit');
    if ('state' in result.value) {
      if (result.value.state === 'exited') return result.value.exit;
      throw processFailure(processId, pid, result.value.error);
    }
  }
}

async function cancelOwned<T>(
  reader: ReadableStreamDefaultReader<T> | undefined,
  stream: ReadableStream<T>
): Promise<void> {
  try {
    if (reader !== undefined) await reader.cancel();
    else await stream.cancel();
  } catch {
    // The primary consumer result wins over cleanup failures.
  }
}
