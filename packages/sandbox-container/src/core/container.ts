import { ManagedProcessSupervisor } from '@repo/sandbox-execution';
import type { Logger, SandboxControlCallback } from '@repo/shared';
import { createLogger } from '@repo/shared';
import { ExtensionHost } from '../extensions/extension-host';
import { TerminalWebSocketHandler } from '../handlers/terminal-ws-handler';
import { SecurityServiceAdapter } from '../security/security-adapter';
import { SecurityService } from '../security/security-service';
import { BackupService } from '../services/backup-service';
import { CommandContextService } from '../services/command-context-service';
import { FileService } from '../services/file-service';
import { InternalCommandRunner } from '../services/internal-command-runner';
import { PortService } from '../services/port-service';
import { ProcessService } from '../services/process-service';
import { TerminalManager } from '../services/terminal-manager';
import { TunnelService } from '../services/tunnel-service';
import { WatchService } from '../services/watch-service';

export interface Dependencies {
  // Services
  fileService: FileService;
  portService: PortService;
  managedProcessSupervisor: ManagedProcessSupervisor;
  processService: ProcessService;
  backupService: BackupService;
  watchService: WatchService;
  tunnelService: TunnelService;
  extensionHost: ExtensionHost;

  // Infrastructure
  logger: Logger;
  security: SecurityService;
  terminalManager: TerminalManager;
  commandContextService: CommandContextService;

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
  private controlCallback: {
    connectionID: string;
    callback: SandboxControlCallback;
  } | null = null;

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
   * Store the DO-side control callback after a capnweb session activates.
   * Close handling supplies the connection ID so stale sessions cannot clear
   * a callback registered by a newer activated session.
   */
  setControlCallback(
    connectionID: string,
    callback: SandboxControlCallback
  ): void {
    this.controlCallback = { connectionID, callback };
  }

  clearControlCallback(connectionID: string): void {
    if (this.controlCallback?.connectionID === connectionID) {
      this.controlCallback = null;
    }
  }

  /** Returns the current peer's control callback or `null`. */
  getControlCallback(): SandboxControlCallback | null {
    return this.controlCallback?.callback ?? null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize infrastructure
    const logger = createLogger({ component: 'container' });
    const security = new SecurityService(logger);
    const securityAdapter = new SecurityServiceAdapter(security);

    // Initialize execution infrastructure
    const terminalManager = new TerminalManager(logger);
    const internalCommandRunner = new InternalCommandRunner();
    const commandContextService = new CommandContextService(
      internalCommandRunner
    );

    // Initialize services
    const fileService = new FileService(
      securityAdapter,
      logger,
      commandContextService
    );
    const portService = new PortService();
    const managedProcessSupervisor = new ManagedProcessSupervisor();
    const processService = new ProcessService({
      supervisor: managedProcessSupervisor,
      logger
    });
    const backupService = new BackupService(logger, commandContextService);
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
      fileService,
      portService,
      managedProcessSupervisor,
      processService,
      backupService,
      watchService,
      tunnelService,
      extensionHost,

      // Infrastructure
      logger,
      security,
      terminalManager,
      commandContextService,

      // Handlers
      terminalWsHandler
    };

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
