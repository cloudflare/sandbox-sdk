import { createLogger, type SandboxControlCallback } from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import { serve } from 'bun';
import { type BunWebSocketTransport, newBunWebSocketRpcSession } from 'capnweb';
import { trustRuntimeCert } from './cert';
import { CONFIG } from './config';
import { SandboxControlAPI } from './control-plane';
import { Container } from './core/container';
import type { TerminalWSData } from './handlers/terminal-ws-handler';

export type CapnwebWSData = {
  type: 'capnweb';
  connectionId: string;
  transport?: BunWebSocketTransport<WSData>;
};

export type WSData = TerminalWSData | CapnwebWSData;

const logger = createLogger({ component: 'container' });
const SERVER_PORT = 3000;

function generateConnectionId(): string {
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function webSocketUpgradeFailedResponse(): Response {
  return new Response('WebSocket upgrade failed', { status: 503 });
}

// Global error handlers to prevent fragmented stack traces in logs
// Bun's default handler writes stack traces line-by-line to stderr,
// which Cloudflare captures as separate log entries
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.warn('Unhandled rejection', {
    error: error.message,
    stack: error.stack
  });
});

export interface ServerInstance {
  port: number;
  cleanup: () => Promise<void>;
}

async function createApplication(): Promise<{
  fetch: (
    req: Request,
    server: ReturnType<typeof serve<WSData>>
  ) => Promise<Response>;
  container: Container;
  controlPlaneAPI: SandboxControlAPI;
}> {
  const container = new Container();
  await container.initialize();

  // Create the control-plane API that calls services directly.
  const controlPlaneAPI = new SandboxControlAPI({
    processService: container.get('processService'),
    fileService: container.get('fileService'),
    portService: container.get('portService'),
    gitService: container.get('gitService'),
    backupService: container.get('backupService'),
    watchService: container.get('watchService'),
    tunnelService: container.get('tunnelService'),
    terminalManager: container.get('terminalManager'),
    extensionHost: container.get('extensionHost'),
    sessionManager: container.get('sessionManager'),
    logger
  });

  return {
    fetch: async (
      req: Request,
      server: ReturnType<typeof serve<WSData>>
    ): Promise<Response> => {
      const upgradeHeader = req.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        const url = new URL(req.url);

        if (url.pathname === '/ws/terminal') {
          const terminalId = url.searchParams.get('terminalId');
          if (!terminalId) {
            return new Response('terminalId query parameter required', {
              status: 400
            });
          }

          const colsParam = url.searchParams.get('cols');
          const rowsParam = url.searchParams.get('rows');

          const upgraded = server.upgrade(req, {
            data: {
              type: 'terminal' as const,
              terminalId,
              connectionId: generateConnectionId(),
              cols: colsParam ? Number.parseInt(colsParam, 10) : undefined,
              rows: rowsParam ? Number.parseInt(rowsParam, 10) : undefined
            }
          });
          if (upgraded) {
            // Bun's server.upgrade() handles the response internally — at runtime the
            // fetch handler returns `undefined` to signal a successful upgrade. The Bun
            // type signature requires `MaybePromise<Response>` (no `undefined`), so we
            // cast through `unknown`. See: https://bun.sh/docs/api/websockets#upgrade
            return undefined as unknown as Response;
          }
          return webSocketUpgradeFailedResponse();
        }

        if (url.pathname === '/rpc') {
          logger.info('Establishing RPC connection');
          const upgraded = server.upgrade(req, {
            data: {
              type: 'capnweb' as const,
              connectionId: generateConnectionId()
            }
          });
          if (upgraded) {
            return undefined as unknown as Response;
          }
          return webSocketUpgradeFailedResponse();
        }
      }

      return new Response('Not Found', { status: 404 });
    },
    container,
    controlPlaneAPI
  };
}

/**
 * Start the HTTP API server on port 3000.
 * Returns server info and a cleanup function for graceful shutdown.
 */
export async function startServer(): Promise<ServerInstance> {
  const app = await createApplication();

  serve<WSData>({
    idleTimeout: 255,
    fetch: (req, server) => app.fetch(req, server),
    error(error) {
      logger.error(
        'Unhandled server error',
        error instanceof Error ? error : new Error(String(error))
      );
      return new Response('Internal Server Error', { status: 500 });
    },
    hostname: '0.0.0.0',
    port: SERVER_PORT,
    websocket: {
      open(ws) {
        try {
          if (ws.data.type === 'terminal') {
            void app.container
              .get('terminalWsHandler')
              .onOpen(ws as ServerWebSocket<TerminalWSData>)
              .catch((err) => {
                logger.error(
                  'Terminal onOpen failed',
                  err instanceof Error ? err : new Error(String(err))
                );
                try {
                  ws.close(1011, 'Internal error');
                } catch {}
              });
          } else if (ws.data.type === 'capnweb') {
            const { stub, transport } = newBunWebSocketRpcSession<
              SandboxControlCallback,
              WSData
            >(ws, app.controlPlaneAPI);
            ws.data.transport = transport;
            // Capture the peer's remote main (the DO's
            // SandboxControlCallback) so the container can push
            // events back — e.g. tunnel-exit notifications.
            app.container.setControlCallback(stub);
            logger.debug('RPC session initialized', {
              connectionId: ws.data.connectionId
            });
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket open handler',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      close(ws, code, reason) {
        try {
          if (ws.data.type === 'terminal') {
            app.container
              .get('terminalWsHandler')
              .onClose(ws as ServerWebSocket<TerminalWSData>, code, reason);
          } else if (ws.data.type === 'capnweb') {
            ws.data.transport?.dispatchClose(code, reason);
            // Forget the peer's control callback. Subsequent tunnel
            // exits resolve `null` from the accessor and become no-ops
            // until a new session opens.
            app.container.setControlCallback(null);
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket close handler',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      async message(ws, message) {
        try {
          if (ws.data.type === 'terminal') {
            app.container
              .get('terminalWsHandler')
              .onMessage(ws as ServerWebSocket<TerminalWSData>, message);
          } else if (ws.data.type === 'capnweb') {
            ws.data.transport?.dispatchMessage(message);
          }
        } catch (error) {
          logger.error(
            'Error in WebSocket message handler',
            error instanceof Error ? error : new Error(String(error))
          );
          try {
            ws.close(1011, 'Internal error');
          } catch {
            // Ignored - connection already closed
          }
        }
      }
    }
  });

  logger.info('Container server started', {
    port: SERVER_PORT,
    hostname: '0.0.0.0'
  });

  if (process.env.SANDBOX_INTERCEPT_HTTPS === '1') {
    await trustRuntimeCert();
  }

  return {
    port: SERVER_PORT,
    // Cleanup handles application-level resources.
    // WebSocket connections are closed automatically when the process exits -
    // Bun's serve() handles transport cleanup on shutdown.
    cleanup: async () => {
      if (!app.container.isInitialized()) return;

      try {
        const processService = app.container.get('processService');
        const portService = app.container.get('portService');
        const watchService = app.container.get('watchService');
        const tunnelService = app.container.get('tunnelService');
        const extensionHost = app.container.get('extensionHost');
        const terminalManager = app.container.get('terminalManager');

        const stoppedWatches = await watchService.stopAllWatches();
        if (stoppedWatches > 0) {
          logger.info('Stopped file watches during shutdown', {
            count: stoppedWatches
          });
        }

        await processService.destroy();
        portService.destroy();
        await tunnelService.destroyAll();
        await terminalManager.destroyAll();
        await extensionHost.stopAll();

        logger.info('Services cleaned up successfully');
      } catch (error) {
        logger.error(
          'Error during cleanup',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  };
}

let shutdownRegistered = false;

/**
 * Register graceful shutdown handlers for SIGTERM and SIGINT.
 * Safe to call multiple times - handlers are only registered once.
 */
export function registerShutdownHandlers(cleanup: () => Promise<void>): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully');
    await cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully');
    process.emit('SIGTERM');
  });
}
