// Port Management Service
import type { PortInfo, Logger, ServiceResult } from '../core/types';

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
      info,
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

  constructor(
    private store: PortStore,
    private security: SecurityService,
    private logger: Logger
  ) {
    // Start cleanup process every hour
    this.startCleanupProcess();
  }

  async exposePort(port: number, name?: string): Promise<ServiceResult<PortInfo>> {
    try {
      // Validate port number
      const validation = this.security.validatePort(port);
      if (!validation.isValid) {
        return {
          success: false,
          error: {
            message: `Port validation failed: ${validation.errors.join(', ')}`,
            code: 'INVALID_PORT',
            details: { port, errors: validation.errors },
          },
        };
      }

      // Check if port is already exposed
      const existing = await this.store.get(port);
      if (existing) {
        return {
          success: false,
          error: {
            message: `Port ${port} is already exposed`,
            code: 'PORT_ALREADY_EXPOSED',
            details: { port, existing },
          },
        };
      }

      const portInfo: PortInfo = {
        port,
        name,
        exposedAt: new Date(),
        status: 'active',
      };

      await this.store.expose(port, portInfo);

      this.logger.info('Port exposed successfully', { port, name });

      return {
        success: true,
        data: portInfo,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to expose port', error instanceof Error ? error : undefined, { port, name });

      return {
        success: false,
        error: {
          message: 'Failed to expose port',
          code: 'PORT_EXPOSE_ERROR',
          details: { port, name, originalError: errorMessage },
        },
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
            code: 'PORT_NOT_EXPOSED',
            details: { port },
          },
        };
      }

      await this.store.unexpose(port);

      this.logger.info('Port unexposed successfully', { port });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to unexpose port', error instanceof Error ? error : undefined, { port });

      return {
        success: false,
        error: {
          message: 'Failed to unexpose port',
          code: 'PORT_UNEXPOSE_ERROR',
          details: { port, originalError: errorMessage },
        },
      };
    }
  }

  async getExposedPorts(): Promise<ServiceResult<PortInfo[]>> {
    try {
      const ports = await this.store.list();
      const portInfos = ports.map(p => p.info);

      return {
        success: true,
        data: portInfos,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to list exposed ports', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: 'Failed to list exposed ports',
          code: 'PORT_LIST_ERROR',
          details: { originalError: errorMessage },
        },
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
            code: 'PORT_NOT_FOUND',
            details: { port },
          },
        };
      }

      return {
        success: true,
        data: portInfo,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to get port info', error instanceof Error ? error : undefined, { port });

      return {
        success: false,
        error: {
          message: 'Failed to get port info',
          code: 'PORT_GET_ERROR',
          details: { port, originalError: errorMessage },
        },
      };
    }
  }

  async proxyRequest(port: number, request: Request): Promise<Response> {
    try {
      // Check if port is exposed
      const portInfo = await this.store.get(port);
      if (!portInfo) {
        return new Response(
          JSON.stringify({
            error: 'Port not found',
            message: `Port ${port} is not exposed`,
            port,
          }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Extract the path from the original request
      const url = new URL(request.url);
      const pathSegments = url.pathname.split('/');
      
      // Remove the /proxy/{port} part to get the actual path
      const targetPath = pathSegments.slice(3).join('/') || '/';
      const targetUrl = `http://localhost:${port}${targetPath}${url.search}`;

      this.logger.info('Proxying request', { 
        port, 
        originalPath: url.pathname, 
        targetPath, 
        targetUrl 
      });

      // Forward the request to the local service
      const proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      const response = await fetch(proxyRequest);

      this.logger.info('Proxy request completed', { 
        port, 
        status: response.status,
        targetUrl 
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Proxy request failed', error instanceof Error ? error : undefined, { port });

      return new Response(
        JSON.stringify({
          error: 'Proxy error',
          message: `Failed to proxy request to port ${port}: ${errorMessage}`,
          port,
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
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
            code: 'PORT_NOT_FOUND',
            details: { port },
          },
        };
      }

      const updatedInfo: PortInfo = {
        ...portInfo,
        status: 'inactive',
      };

      await this.store.expose(port, updatedInfo);

      this.logger.info('Port marked as inactive', { port });

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to mark port as inactive', error instanceof Error ? error : undefined, { port });

      return {
        success: false,
        error: {
          message: 'Failed to mark port as inactive',
          code: 'PORT_UPDATE_ERROR',
          details: { port, originalError: errorMessage },
        },
      };
    }
  }

  async cleanupInactivePorts(): Promise<ServiceResult<number>> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const cleaned = await this.store.cleanup(oneHourAgo);

      if (cleaned > 0) {
        this.logger.info('Cleaned up inactive ports', { count: cleaned });
      }

      return {
        success: true,
        data: cleaned,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to cleanup ports', error instanceof Error ? error : undefined);

      return {
        success: false,
        error: {
          message: 'Failed to cleanup ports',
          code: 'PORT_CLEANUP_ERROR',
          details: { originalError: errorMessage },
        },
      };
    }
  }

  private startCleanupProcess(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupInactivePorts();
    }, 60 * 60 * 1000); // 1 hour
  }

  // Cleanup method for graceful shutdown
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}