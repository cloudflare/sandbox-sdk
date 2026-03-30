import type { Logger } from '@repo/shared';
import { createLogger, GitLogger } from '@repo/shared';
import { PtyWebSocketHandler } from '../handlers/pty-ws-handler';
import { SecurityServiceAdapter } from '../security/security-adapter';
import { SecurityService } from '../security/security-service';
import { BackupService } from '../services/backup-service';
import { DesktopService } from '../services/desktop-service';
import { FileService } from '../services/file-service';
import { GitService } from '../services/git-service';
import { InterpreterService } from '../services/interpreter-service';
import { InMemoryPortStore, PortService } from '../services/port-service';
import { ProcessService } from '../services/process-service';
import { ProcessStore } from '../services/process-store';
import { SessionManager } from '../services/session-manager';
import { WatchService } from '../services/watch-service';

export interface Dependencies {
  // Services
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  interpreterService: InterpreterService;
  backupService: BackupService;
  desktopService: DesktopService;
  watchService: WatchService;
  sessionManager: SessionManager;

  // Infrastructure
  logger: Logger;
  security: SecurityService;

  // PTY handler (WebSocket-based, not part of the RPC layer)
  ptyWsHandler: PtyWebSocketHandler;
}

export class Container {
  private dependencies: Partial<Dependencies> = {};
  private initialized = false;

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

    return dependency as Dependencies[T];
  }

  set<T extends keyof Dependencies>(
    key: T,
    implementation: Dependencies[T]
  ): void {
    this.dependencies[key] = implementation;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const logger = createLogger({ component: 'container' });
    const security = new SecurityService(logger);
    const securityAdapter = new SecurityServiceAdapter(security);

    const processStore = new ProcessStore(logger);
    const portStore = new InMemoryPortStore();
    const sessionManager = new SessionManager(logger);
    const gitLogger = new GitLogger(logger);

    const processService = new ProcessService(
      processStore,
      logger,
      sessionManager
    );
    const fileService = new FileService(
      securityAdapter,
      logger,
      sessionManager
    );
    const portService = new PortService(portStore, securityAdapter, logger);
    const gitService = new GitService(
      securityAdapter,
      sessionManager,
      gitLogger
    );
    const interpreterService = new InterpreterService(logger);
    const backupService = new BackupService(logger, sessionManager);
    const desktopService = new DesktopService(logger);
    const watchService = new WatchService(logger);
    const ptyWsHandler = new PtyWebSocketHandler(sessionManager, logger);

    this.dependencies = {
      processService,
      fileService,
      portService,
      gitService,
      interpreterService,
      backupService,
      desktopService,
      watchService,
      sessionManager,
      logger,
      security,
      ptyWsHandler
    };

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
