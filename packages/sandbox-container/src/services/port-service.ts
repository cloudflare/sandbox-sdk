// Port readiness service

import type { PortCheckRequest, PortCheckResponse } from '@repo/shared';

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
