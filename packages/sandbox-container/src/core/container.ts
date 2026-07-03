import type { Logger, SandboxControlCallback } from '@repo/shared';
import { createLogger } from '@repo/shared';
import { ExtensionHost } from '../extensions/extension-host';
import { TerminalWebSocketHandler } from '../handlers/terminal-ws-handler';
import { SecurityServiceAdapter } from '../security/security-adapter';
import { SecurityService } from '../security/security-service';
import { BackupService } from '../services/backup-service';
import { ExecutionService } from '../services/execution-service';
import { FileService } from '../services/file-service';
import { PortService } from '../services/port-service';
import { ProcessService } from '../services/process-service';
import { ProcessStore } from '../services/process-store';
import { SessionManager } from '../services/session-manager';
import { TerminalManager } from '../services/terminal-manager';
import { TunnelService } from '../services/tunnel-service';
import { WatchService } from '../services/watch-service';

export interface Dependencies {
  // Services
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  backupService: BackupService;
  watchService: WatchService;
  tunnelService: TunnelService;
  extensionHost: ExtensionHost;

  // Infrastructure
  logger: Logger;
  security: SecurityService;
  sessionManager: SessionManager;
  terminalManager: TerminalManager;
  executionService: ExecutionService;

  // Handlers
  terminalWsHandler: TerminalWebSocketHandler;
}

export class Container {
  private dependencies: Partial<Dependencies> = {};
  private initialized = false;
  // Latest capnweb remote main observed from a `capnweb` WS upgrade.
  // Updated on every session open so tunnel exits and other future
  // container→DO events route to the current peer. Cleared by the WS
  // close handler. `null` between connections.
  private controlCallback: SandboxControlCallback | null = null;

  get<T extends keyof Dependencies>(key: T): Dependencies[T] {
    if (!this.initialized) {
      throw new Error('Container not initialized. Call initialize() first.');
    }

    const dependency = this.dependencies[key];
    if (!dependency) {
      throw new Error(
        `Dependency '${key}' not found. Make sure to initialize the container.`
      );
    }

    // Safe cast because we know the container is initialized and dependency exists
    return dependency as Dependencies[T];
  }

  set<T extends keyof Dependencies>(
    key: T,
    implementation: Dependencies[T]
  ): void {
    this.dependencies[key] = implementation;
  }

  /**
   * Set / clear the DO-side control callback exposed via the current
   * capnweb session's remote main. Called from `server.ts` on each
   * `capnweb` WS open (with the new peer) and on close (with `null`).
   */
  setControlCallback(cb: SandboxControlCallback | null): void {
    this.controlCallback = cb;
  }

  /** Returns the current peer's control callback or `null`. */
  getControlCallback(): SandboxControlCallback | null {
    return this.controlCallback;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize infrastructure
    const logger = createLogger({ component: 'container' });
    const security = new SecurityService(logger);
    const securityAdapter = new SecurityServiceAdapter(security);

    // Initialize stores
    const processStore = new ProcessStore(logger);

    // Initialize execution infrastructure
    const sessionManager = new SessionManager(logger);
    const terminalManager = new TerminalManager(logger);
    const executionService = new ExecutionService(sessionManager, logger);

    // Initialize services
    const processService = new ProcessService(
      processStore,
      logger,
      executionService
    );
    const fileService = new FileService(
      securityAdapter,
      logger,
      executionService
    );
    const portService = new PortService();
    const backupService = new BackupService(logger, executionService);
    const watchService = new WatchService(logger);
    const tunnelService = new TunnelService(logger, () =>
      this.getControlCallback()
    );
    const extensionHost = new ExtensionHost(logger);

    // Initialize handlers
    const terminalWsHandler = new TerminalWebSocketHandler(
      terminalManager,
      logger
    );

    // Store all dependencies
    this.dependencies = {
      // Services
      processService,
      fileService,
      portService,
      backupService,
      watchService,
      tunnelService,
      extensionHost,

      // Infrastructure
      logger,
      security,
      sessionManager,
      terminalManager,
      executionService,

      // Handlers
      terminalWsHandler
    };

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
