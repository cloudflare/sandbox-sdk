// Dependency Injection Container
// Import service interfaces
import type {
  CommandResult,
  ExecuteRequest,
  ExposePortRequest,
  FileRequest,
  GitCheckoutRequest,
  Logger,
  NextFunction,
  PortInfo,
  ProcessRecord,
  RequestContext,
  ServiceResult,
  StartProcessRequest,
  ValidationResult
} from './types';

export interface ProcessService {
  startProcess(command: string, options: Record<string, unknown>): Promise<ServiceResult<ProcessRecord>>;
  executeCommand(command: string, options: Record<string, unknown>): Promise<ServiceResult<CommandResult>>;
  getProcess(id: string): Promise<ServiceResult<ProcessRecord>>;
  killProcess(id: string): Promise<ServiceResult<void>>;
  listProcesses(): Promise<ServiceResult<ProcessRecord[]>>;
  destroy(): Promise<void>;
}

export interface FileService {
  read(path: string, options?: { encoding?: string }): Promise<ServiceResult<string>>;
  write(path: string, content: string, options?: { encoding?: string }): Promise<ServiceResult<void>>;
  delete(path: string): Promise<ServiceResult<void>>;
  rename(oldPath: string, newPath: string): Promise<ServiceResult<void>>;
  move(sourcePath: string, destinationPath: string): Promise<ServiceResult<void>>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<ServiceResult<void>>;
  exists(path: string): Promise<ServiceResult<boolean>>;
}

export interface PortService {
  exposePort(port: number, name?: string): Promise<ServiceResult<PortInfo>>;
  unexposePort(port: number): Promise<ServiceResult<void>>;
  getExposedPorts(): Promise<ServiceResult<PortInfo[]>>;
  proxyRequest(port: number, request: Request): Promise<Response>;
  destroy(): void;
}

export interface GitService {
  cloneRepository(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<ServiceResult<{ path: string; branch: string }>>;
  checkoutBranch(repoPath: string, branch: string): Promise<ServiceResult<void>>;
}

export interface SecurityService {
  validatePath(path: string): ValidationResult<string>;
  sanitizePath(path: string): string;
  validatePort(port: number): ValidationResult<number>;
  validateCommand(command: string): ValidationResult<string>;
  validateGitUrl(url: string): ValidationResult<string>;
}

export interface RequestValidator {
  validateExecuteRequest(request: unknown): ValidationResult<ExecuteRequest>;
  validateFileRequest(request: unknown, operation?: string): ValidationResult<FileRequest>;
  validateProcessRequest(request: unknown): ValidationResult<StartProcessRequest>;
  validatePortRequest(request: unknown): ValidationResult<ExposePortRequest>;
  validateGitRequest(request: unknown): ValidationResult<GitCheckoutRequest>;
}

// Handler interfaces
export interface ExecuteHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface FileHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface ProcessHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface PortHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface GitHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface InterpreterHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface MiscHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

export interface SessionHandler {
  handle(request: Request, context: RequestContext): Promise<Response>;
}

// Middleware interfaces  
export interface CorsMiddleware {
  handle(request: Request, context: RequestContext, next: NextFunction): Promise<Response>;
}

export interface ValidationMiddleware {
  handle(request: Request, context: RequestContext, next: NextFunction): Promise<Response>;
}

export interface LoggingMiddleware {
  handle(request: Request, context: RequestContext, next: NextFunction): Promise<Response>;
}

export interface InterpreterService {
  getHealthStatus(): Promise<ServiceResult<{ ready: boolean; initializing: boolean; progress: number }>>;
  createContext(request: { language?: string; cwd?: string }): Promise<ServiceResult<{ id: string; language: string; cwd: string; createdAt: string; lastUsed: string }>>;
  listContexts(): Promise<ServiceResult<Array<{ id: string; language: string; cwd: string; createdAt: string; lastUsed: string }>>>;
  deleteContext(contextId: string): Promise<ServiceResult<void>>;
  executeCode(contextId: string, code: string, language?: string): Promise<Response>;
}

export interface Dependencies {
  // Services
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  interpreterService: InterpreterService;

  // Infrastructure
  logger: Logger;
  security: SecurityService;
  validator: RequestValidator;

  // Handlers
  executeHandler: ExecuteHandler;
  fileHandler: FileHandler;
  processHandler: ProcessHandler;
  portHandler: PortHandler;
  gitHandler: GitHandler;
  interpreterHandler: InterpreterHandler;
  sessionHandler: SessionHandler;
  miscHandler: MiscHandler;

  // Middleware
  corsMiddleware: CorsMiddleware;
  validationMiddleware: ValidationMiddleware;
  loggingMiddleware: LoggingMiddleware;
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
      throw new Error(`Dependency '${key}' not found. Make sure to initialize the container.`);
    }
    
    // Safe cast because we know the container is initialized and dependency exists
    return dependency as Dependencies[T];
  }

  set<T extends keyof Dependencies>(key: T, implementation: Dependencies[T]): void {
    this.dependencies[key] = implementation;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Import all necessary classes
    const { ConsoleLogger } = await import('./logger');
    const { SecurityService } = await import('../security/security-service');
    const { SecurityServiceAdapter } = await import('../security/security-adapter');
    const { RequestValidator } = await import('../validation/request-validator');
    
    // Services
    const { ProcessService, InMemoryProcessStore } = await import('../services/process-service');
    const { FileService } = await import('../services/file-service');
    const { PortService, InMemoryPortStore } = await import('../services/port-service');
    const { GitService } = await import('../services/git-service');
    const { InterpreterService } = await import('../services/interpreter-service');
    const { SessionManager } = await import('../services/session-manager');

    // Handlers
    const { SessionHandler } = await import('../handlers/session-handler');
    const { ExecuteHandler } = await import('../handlers/execute-handler');
    const { FileHandler } = await import('../handlers/file-handler');
    const { ProcessHandler } = await import('../handlers/process-handler');
    const { PortHandler } = await import('../handlers/port-handler');
    const { GitHandler } = await import('../handlers/git-handler');
    const { InterpreterHandler } = await import('../handlers/interpreter-handler');
    const { MiscHandler } = await import('../handlers/misc-handler');

    // Middleware
    const { CorsMiddleware } = await import('../middleware/cors');
    const { ValidationMiddleware } = await import('../middleware/validation');
    const { LoggingMiddleware } = await import('../middleware/logging');

    // Initialize infrastructure
    const logger = new ConsoleLogger();
    const security = new SecurityService(logger);
    const securityAdapter = new SecurityServiceAdapter(security);
    const validator = new RequestValidator(security);

    // Initialize stores
    const processStore = new InMemoryProcessStore();
    const portStore = new InMemoryPortStore();

    // Initialize SessionManager (always - no test-specific conditionals)
    console.log('[Container] Initializing SessionManager');
    const sessionManager = new SessionManager(logger);
    console.log('[Container] SessionManager created');

    // Initialize services
    const processService = new ProcessService(processStore, logger, sessionManager);
    const fileService = new FileService(securityAdapter, logger);
    const portService = new PortService(portStore, securityAdapter, logger);
    const gitService = new GitService(securityAdapter, logger);
    const interpreterService = new InterpreterService(logger);

    // Initialize handlers
    const sessionHandler = new SessionHandler(sessionManager, logger);
    const executeHandler = new ExecuteHandler(processService, logger);
    const fileHandler = new FileHandler(fileService, logger);
    const processHandler = new ProcessHandler(processService, logger);
    const portHandler = new PortHandler(portService, logger);
    const gitHandler = new GitHandler(gitService, logger);
    const interpreterHandler = new InterpreterHandler(interpreterService, logger);
    const miscHandler = new MiscHandler(logger);
    
    // Initialize middleware
    const corsMiddleware = new CorsMiddleware();
    const validationMiddleware = new ValidationMiddleware(validator);
    const loggingMiddleware = new LoggingMiddleware(logger);

    // Store all dependencies
    this.dependencies = {
      // Services
      processService,
      fileService,
      portService,
      gitService,
      interpreterService,

      // Infrastructure
      logger,
      security,
      validator,

      // Handlers
      executeHandler,
      fileHandler,
      processHandler,
      portHandler,
      gitHandler,
      interpreterHandler,
      sessionHandler,
      miscHandler,

      // Middleware
      corsMiddleware,
      validationMiddleware,
      loggingMiddleware,
    };

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // Helper method to get all dependencies (for testing)
  getAllDependencies(): Partial<Dependencies> {
    return { ...this.dependencies };
  }
}