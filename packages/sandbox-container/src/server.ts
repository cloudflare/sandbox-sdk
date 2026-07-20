import {
  createLogger,
  type RuntimeMetadata,
  type SandboxControlCallback
} from '@repo/shared';
import type { ServerWebSocket } from 'bun';
import { serve } from 'bun';
import { type BunWebSocketTransport, newBunWebSocketRpcSession } from 'capnweb';
import { trustRuntimeCert } from './cert';
import { CONFIG } from './config';
import { type SandboxAPIDeps, SandboxControlAPI } from './control-plane';
import {
  CONTROL_PROTOCOL_VERSION,
  ControlSession
} from './control-plane/session';
import { Container } from './core/container';
import type { TerminalWSData } from './handlers/terminal-ws-handler';

export type CapnwebWSData = {
  type: 'capnweb';
  connectionId: string;
  transport?: BunWebSocketTransport<WSData>;
  controlSession?: ControlSession;
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

function terminalWebSocketUpgradeResponse(
  req: Request,
  server: { upgrade(req: Request, options: { data: TerminalWSData }): boolean },
  runtimeIncarnationID: string
): Response {
  const url = new URL(req.url);
  const terminalId = url.searchParams.get('terminalId');
  if (!terminalId) {
    return new Response('terminalId query parameter required', { status: 400 });
  }

  const expectedRuntimeIncarnationID = url.searchParams.get(
    'runtimeIncarnationID'
  );
  if (expectedRuntimeIncarnationID !== runtimeIncarnationID) {
    return new Response('Runtime incarnation mismatch', { status: 409 });
  }

  const colsParam = url.searchParams.get('cols');
  const rowsParam = url.searchParams.get('rows');
  const cursor = url.searchParams.get('cursor') ?? undefined;

  const upgraded = server.upgrade(req, {
    data: {
      type: 'terminal' as const,
      terminalId,
      connectionId: generateConnectionId(),
      cursor,
      runtimeIncarnationID: expectedRuntimeIncarnationID,
      cols: colsParam ? Number.parseInt(colsParam, 10) : undefined,
      rows: rowsParam ? Number.parseInt(rowsParam, 10) : undefined
    }
  });
  if (upgraded) return undefined as unknown as Response;
  return webSocketUpgradeFailedResponse();
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
  controlPlaneMetadata: RuntimeMetadata;
  controlPlaneDeps: SandboxAPIDeps;
}> {
  const container = new Container();
  await container.initialize();

  const controlPlaneMetadata: RuntimeMetadata = {
    runtimeIncarnationID: crypto.randomUUID(),
    sandboxVersion: process.env.SANDBOX_VERSION || 'unknown',
    controlProtocolVersion: CONTROL_PROTOCOL_VERSION
  };

  const controlPlaneDeps: SandboxAPIDeps = {
    fileService: container.get('fileService'),
    portService: container.get('portService'),
    processService: container.get('processService'),
    backupService: container.get('backupService'),
    watchService: container.get('watchService'),
    tunnelService: container.get('tunnelService'),
    terminalManager: container.get('terminalManager'),
    extensionHost: container.get('extensionHost'),
    commandContextService: container.get('commandContextService'),
    logger
  };

  return {
    fetch: async (
      req: Request,
      server: ReturnType<typeof serve<WSData>>
    ): Promise<Response> => {
      const upgradeHeader = req.headers.get('Upgrade');
      if (upgradeHeader?.toLowerCase() === 'websocket') {
        const url = new URL(req.url);

        if (url.pathname === '/ws/terminal') {
          return terminalWebSocketUpgradeResponse(
            req,
            server,
            controlPlaneMetadata.runtimeIncarnationID
          );
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
    controlPlaneMetadata,
    controlPlaneDeps
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
            const session = new ControlSession({
              metadata: app.controlPlaneMetadata,
              connectionID: ws.data.connectionId,
              peerCallback: undefined,
              registerControlCallback: (connectionID, callback) => {
                app.container.setControlCallback(connectionID, callback);
              },
              clearControlCallback: (connectionID) => {
                app.container.clearControlCallback(connectionID);
              }
            });
            const api = new SandboxControlAPI(app.controlPlaneDeps, session);
            const { stub, transport } = newBunWebSocketRpcSession<
              SandboxControlCallback,
              WSData
            >(ws, api);
            ws.data.transport = transport;
            session.setPeerCallback(stub);
            ws.data.controlSession = session;
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
            ws.data.controlSession?.close();
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
        const portService = app.container.get('portService');
        const watchService = app.container.get('watchService');
        const tunnelService = app.container.get('tunnelService');
        const extensionHost = app.container.get('extensionHost');
        const terminalManager = app.container.get('terminalManager');
        const processService = app.container.get('processService');

        const stoppedWatches = await watchService.stopAllWatches();
        if (stoppedWatches > 0) {
          logger.info('Stopped file watches during shutdown', {
            count: stoppedWatches
          });
        }

        portService.destroy();
        await tunnelService.destroyAll();
        await terminalManager.destroyAll();
        await extensionHost.stopAll();
        await processService.shutdown();

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

let registeredShutdownHandlers:
  | {
      sigterm: () => void;
      sigint: () => void;
    }
  | undefined;

/**
 * Register graceful shutdown handlers for SIGTERM and SIGINT.
 * Later registrations replace the previous owner so tests and server
 * instances do not retain stale cleanup callbacks.
 */
export function registerShutdownHandlers(cleanup: () => Promise<void>): void {
  if (registeredShutdownHandlers) {
    process.off('SIGTERM', registeredShutdownHandlers.sigterm);
    process.off('SIGINT', registeredShutdownHandlers.sigint);
  }

  let cleanupPromise: Promise<void> | undefined;
  const runCleanupOnce = (): Promise<void> => {
    cleanupPromise ??= cleanup();
    return cleanupPromise;
  };

  const sigterm = (): void => {
    logger.info('Received SIGTERM, shutting down gracefully');
    void runCleanupOnce().finally(() => process.exit(0));
  };

  const sigint = (): void => {
    logger.info('Received SIGINT, shutting down gracefully');
    sigterm();
  };

  registeredShutdownHandlers = { sigterm, sigint };
  process.on('SIGTERM', sigterm);
  process.on('SIGINT', sigint);
}
