// Port Management Service

import type { Logger, PortCheckRequest, PortCheckResponse } from '@repo/shared';
import type {
  InvalidPortContext,
  PortAlreadyExposedContext,
  PortErrorContext,
  PortNotExposedContext
} from '@repo/shared/errors';
import { ErrorCode } from '@repo/shared/errors';
import type {
  PortInfo,
  ProxyErrorResponse,
  ServiceResult
} from '../core/types';
import { PortManager } from '../managers/port-manager';

export interface SecurityService {
  validatePort(port: number): { isValid: boolean; errors: string[] };
}

export interface PortStore {
  expose(port: number, info: PortInfo): Promise<void>;
  unexpose(port: number): Promise<void>;
  get(port: number): Promise<PortInfo | null>;
  list(): Promise<Array<{ port: number; info: PortInfo }>>;
  cleanup(olderThan: Date): Promise<number>;
}

// In-memory implementation
export class InMemoryPortStore implements PortStore {
  private exposedPorts = new Map<number, PortInfo>();

  async expose(port: number, info: PortInfo): Promise<void> {
    this.exposedPorts.set(port, info);
  }

  async unexpose(port: number): Promise<void> {
    this.exposedPorts.delete(port);
  }

  async get(port: number): Promise<PortInfo | null> {
    return this.exposedPorts.get(port) || null;
  }

  async list(): Promise<Array<{ port: number; info: PortInfo }>> {
    return Array.from(this.exposedPorts.entries()).map(([port, info]) => ({
      port,
      info
    }));
  }

  async cleanup(olderThan: Date): Promise<number> {
    let cleaned = 0;
    for (const [port, info] of Array.from(this.exposedPorts.entries())) {
      if (info.exposedAt < olderThan && info.status === 'inactive') {
        this.exposedPorts.delete(port);
        cleaned++;
      }
    }
    return cleaned;
  }

  // Helper methods for testing
  clear(): void {
    this.exposedPorts.clear();
  }

  size(): number {
    return this.exposedPorts.size;
  }
}

export class PortService {
  private cleanupInterval: Timer | null = null;
  private manager: PortManager;

  constructor(
    private store: PortStore,
    private security: SecurityService,
    private logger: Logger
  ) {
    this.manager = new PortManager();
    // Start cleanup process every hour
    this.startCleanupProcess();
  }

  async exposePort(
    port: number,
    name?: string
  ): Promise<ServiceResult<PortInfo>> {
    try {
      // Validate port number
      const validation = this.security.validatePort(port);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Invalid port number ${port}: ${validation.errors.join(
              ', '
            )}`,
            code: ErrorCode.INVALID_PORT_NUMBER,
            details: {
              port,
              reason: validation.errors.join(', ')
            } satisfies InvalidPortContext
          }
        };
      }

      // Check if port is already exposed
      const existing = await this.store.get(port);
      if (existing) {
        return {
          success: false,
          error: {
            message: `Port ${port}${
              existing.name ? ` (${existing.name})` : ''
            } is already exposed`,
            code: ErrorCode.PORT_ALREADY_EXPOSED,
            details: {
              port,
              portName: existing.name
            } satisfies PortAlreadyExposedContext
          }
        };
      }

      const portInfo = this.manager.createPortInfo(port, name);

      await this.store.expose(port, portInfo);

      return {
        success: true,
        data: portInfo
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to expose port',
        error instanceof Error ? error : undefined,
        { port, name }
      );

      return {
        success: false,
        error: {
          message: `Failed to expose port ${port}${
            name ? ` (${name})` : ''
          }: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port,
            portName: name,
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  async unexposePort(port: number): Promise<ServiceResult<void>> {
    try {
      // Check if port is exposed
      const existing = await this.store.get(port);
      if (!existing) {
        return {
          success: false,
          error: {
            message: `Port ${port} is not exposed`,
            code: ErrorCode.PORT_NOT_EXPOSED,
            details: {
              port
            } satisfies PortNotExposedContext
          }
        };
      }

      await this.store.unexpose(port);

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to unexpose port',
        error instanceof Error ? error : undefined,
        { port }
      );

      return {
        success: false,
        error: {
          message: `Failed to unexpose port ${port}: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port,
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  async getExposedPorts(): Promise<ServiceResult<PortInfo[]>> {
    try {
      const ports = await this.store.list();
      const portInfos = ports.map((p) => p.info);

      return {
        success: true,
        data: portInfos
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to list exposed ports',
        error instanceof Error ? error : undefined
      );

      return {
        success: false,
        error: {
          message: `Failed to list exposed ports: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port: 0, // No specific port for list operation
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  async getPortInfo(port: number): Promise<ServiceResult<PortInfo>> {
    try {
      const portInfo = await this.store.get(port);

      if (!portInfo) {
        return {
          success: false,
          error: {
            message: `Port ${port} is not exposed`,
            code: ErrorCode.PORT_NOT_EXPOSED,
            details: {
              port
            } satisfies PortNotExposedContext
          }
        };
      }

      return {
        success: true,
        data: portInfo
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to get port info',
        error instanceof Error ? error : undefined,
        { port }
      );

      return {
        success: false,
        error: {
          message: `Failed to get info for port ${port}: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port,
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  async proxyRequest(port: number, request: Request): Promise<Response> {
    try {
      // Check if port is exposed
      const portInfo = await this.store.get(port);
      if (!portInfo) {
        const errorResponse: ProxyErrorResponse = {
          error: 'Port not found',
          message: `Port ${port} is not exposed`,
          port
        };
        return new Response(JSON.stringify(errorResponse), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Parse proxy path using manager
      const { targetPath, targetUrl } = this.manager.parseProxyPath(
        request.url,
        port
      );

      // Forward the request to the local service
      const proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });

      const response = await fetch(proxyRequest);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Proxy request failed',
        error instanceof Error ? error : undefined,
        { port }
      );

      const errorResponse: ProxyErrorResponse = {
        error: 'Proxy error',
        message: `Failed to proxy request to port ${port}: ${errorMessage}`,
        port
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async markPortInactive(port: number): Promise<ServiceResult<void>> {
    try {
      const portInfo = await this.store.get(port);
      if (!portInfo) {
        return {
          success: false,
          error: {
            message: `Port ${port} is not exposed`,
            code: ErrorCode.PORT_NOT_EXPOSED,
            details: {
              port
            } satisfies PortNotExposedContext
          }
        };
      }

      const updatedInfo = this.manager.createInactivePortInfo(portInfo);

      await this.store.expose(port, updatedInfo);

      return {
        success: true
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to mark port as inactive',
        error instanceof Error ? error : undefined,
        { port }
      );

      return {
        success: false,
        error: {
          message: `Failed to mark port ${port} as inactive: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port,
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  async cleanupInactivePorts(): Promise<ServiceResult<number>> {
    try {
      const threshold = this.manager.calculateCleanupThreshold();
      const cleaned = await this.store.cleanup(threshold);

      return {
        success: true,
        data: cleaned
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        'Failed to cleanup ports',
        error instanceof Error ? error : undefined
      );

      return {
        success: false,
        error: {
          message: `Failed to cleanup inactive ports: ${errorMessage}`,
          code: ErrorCode.PORT_OPERATION_ERROR,
          details: {
            port: 0, // No specific port for cleanup operation
            stderr: errorMessage
          } satisfies PortErrorContext
        }
      };
    }
  }

  /**
   * Check if a port is ready to accept connections
   * Supports both TCP and HTTP modes
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
    } else {
      return this.checkHttpReady(port, path, statusMin, statusMax);
    }
  }

  private async checkTcpReady(port: number): Promise<PortCheckResponse> {
    const TCP_TIMEOUT_MS = 5000; // 5 second timeout matching HTTP check

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
      // Connection succeeded
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
        signal: AbortSignal.timeout(5000) // 5 second timeout for individual check
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

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(
      async () => {
        await this.cleanupInactivePorts();
      },
      60 * 60 * 1000
    ); // 1 hour
  }

  // Cleanup method for graceful shutdown
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
