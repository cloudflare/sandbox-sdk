// Port readiness service

import type {
  PortCheckRequest,
  PortCheckResponse,
  PortWatchEvent,
  PortWatchRPCOptions
} from '@repo/shared';

export class PortService {
  /**
   * Check if a port is ready to accept connections.
   * Supports both TCP and HTTP modes.
   */
  async checkPortReady(request: PortCheckRequest): Promise<PortCheckResponse> {
    const {
      port,
      mode,
      path = '/',
      statusMin = 200,
      statusMax = 399
    } = request;

    if (mode === 'tcp') {
      return this.checkTcpReady(port);
    }

    return this.checkHttpReady(port, path, statusMin, statusMax);
  }

  openWatch(
    port: number,
    options: PortWatchRPCOptions = {}
  ): ReadableStream<PortWatchEvent> {
    const mode = options.mode ?? 'tcp';
    const path = options.path;
    const { statusMin, statusMax } = statusRange(options.status);
    const clampedInterval = Math.max(
      100,
      Math.min(options.interval ?? 500, 10000)
    );
    let cancelled = false;
    let pollingSleep: PollingSleep | undefined;

    return new ReadableStream<PortWatchEvent>({
      start: async (controller) => {
        controller.enqueue({ type: 'watching', port });
        try {
          while (!cancelled) {
            const result = await this.checkPortReady({
              port,
              mode,
              path,
              statusMin,
              statusMax
            });
            if (cancelled) return;
            if (result.ready) {
              controller.enqueue({
                type: 'ready',
                port,
                statusCode: result.statusCode
              });
              return;
            }
            pollingSleep = createPollingSleep(clampedInterval);
            await pollingSleep.promise;
            pollingSleep = undefined;
          }
        } catch (error) {
          if (!cancelled) {
            controller.enqueue({
              type: 'error',
              port,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        } finally {
          closeController(controller);
        }
      },
      cancel() {
        cancelled = true;
        pollingSleep?.cancel();
      }
    });
  }

  private async checkTcpReady(port: number): Promise<PortCheckResponse> {
    const TCP_TIMEOUT_MS = 5000;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('TCP connection timeout')),
          TCP_TIMEOUT_MS
        );
      });

      const connectPromise = Bun.connect({
        hostname: 'localhost',
        port,
        socket: {
          data() {},
          open(socket) {
            socket.end();
          },
          error() {},
          close() {}
        }
      });

      const socket = await Promise.race([connectPromise, timeoutPromise]);
      socket.end();
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : 'TCP connection failed'
      };
    }
  }

  private async checkHttpReady(
    port: number,
    path: string,
    statusMin: number,
    statusMax: number
  ): Promise<PortCheckResponse> {
    try {
      const url = `http://localhost:${port}${path.startsWith('/') ? path : `/${path}`}`;
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      const statusCode = response.status;
      const ready = statusCode >= statusMin && statusCode <= statusMax;

      return {
        ready,
        statusCode,
        error: ready
          ? undefined
          : `HTTP status ${statusCode} not in expected range ${statusMin}-${statusMax}`
      };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : 'HTTP request failed'
      };
    }
  }

  destroy(): void {
    // No persistent resources to release.
  }
}

function statusRange(status: PortWatchRPCOptions['status']): {
  statusMin: number;
  statusMax: number;
} {
  if (typeof status === 'number')
    return { statusMin: status, statusMax: status };
  return {
    statusMin: status?.min ?? 200,
    statusMax: status?.max ?? 399
  };
}

interface PollingSleep {
  promise: Promise<void>;
  cancel(): void;
}

function createPollingSleep(ms: number): PollingSleep {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveSleep = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveSleep = resolve;
    timeout = setTimeout(() => {
      timeout = undefined;
      resolve();
    }, ms);
  });
  return {
    promise,
    cancel() {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      resolveSleep();
    }
  };
}

function closeController<T>(
  controller: ReadableStreamDefaultController<T>
): void {
  try {
    controller.close();
  } catch {
    // The stream may already be closed by consumer cancellation.
  }
}
