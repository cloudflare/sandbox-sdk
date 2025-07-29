// Dependency Injection Container
import type { 
  Logger,
} from './types';

// Import service interfaces (we'll create these later)
export interface SessionService {
  createSession(): Promise<any>;
  getSession(id: string): Promise<any>;
  updateSession(id: string, data: any): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export interface ProcessService {
  startProcess(command: string, options: any): Promise<any>;
  executeCommand(command: string, options: any): Promise<any>;
  getProcess(id: string): Promise<any>;
  killProcess(id: string): Promise<void>;
  listProcesses(): Promise<any[]>;
}

export interface FileService {
  read(path: string, options?: any): Promise<string>;
  write(path: string, content: string, options?: any): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  move(sourcePath: string, destinationPath: string): Promise<void>;
  mkdir(path: string, options?: any): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface PortService {
  exposePort(port: number, name?: string): Promise<any>;
  unexposePort(port: number): Promise<void>;
  getExposedPorts(): Promise<any[]>;
  proxyRequest(port: number, request: Request): Promise<Response>;
}

export interface GitService {
  cloneRepository(repoUrl: string, options: any): Promise<any>;
  checkoutBranch(repoPath: string, branch: string): Promise<any>;
}

export interface SecurityService {
  validatePath(path: string): any;
  sanitizePath(path: string): string;
  validatePort(port: number): any;
  validateCommand(command: string): any;
  validateGitUrl(url: string): any;
}

export interface RequestValidator {
  validateExecuteRequest(request: unknown): any;
  validateFileRequest(request: unknown): any;
  validateProcessRequest(request: unknown): any;
  validatePortRequest(request: unknown): any;
  validateGitRequest(request: unknown): any;
}

// Handler interfaces
export interface ExecuteHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface FileHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface ProcessHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface PortHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface GitHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface MiscHandler {
  handle(request: any, context: any): Promise<any>;
}

export interface SessionHandler {
  handle(request: any, context: any): Promise<any>;
}

// Middleware interfaces
export interface CorsMiddleware {
  handle(request: Request, context: any, next: any): Promise<Response>;
}

export interface ValidationMiddleware {
  handle(request: Request, context: any, next: any): Promise<Response>;
}

export interface LoggingMiddleware {
  handle(request: Request, context: any, next: any): Promise<Response>;
}

export interface Dependencies {
  // Services
  sessionService: SessionService;
  processService: ProcessService;
  fileService: FileService;
  portService: PortService;
  gitService: GitService;
  
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
  sessionHandler: SessionHandler;
  miscHandler: MiscHandler;
  
  // Middleware
  corsMiddleware: CorsMiddleware;
  validationMiddleware: ValidationMiddleware;
  loggingMiddleware: LoggingMiddleware;
}

export class DIContainer {
  private dependencies: Partial<Dependencies> = {};
  private initialized = false;

  constructor() {
    // Dependencies will be initialized later when we create the services
  }

  get<T extends keyof Dependencies>(key: T): Dependencies[T] {
    const dependency = this.dependencies[key];
    if (!dependency) {
      throw new Error(`Dependency '${key}' not found. Make sure to initialize the container.`);
    }
    return dependency;
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
    const { RequestValidator } = await import('../validation/request-validator');
    
    // Services
    const { SessionService, InMemorySessionStore } = await import('../services/session-service');
    const { ProcessService, InMemoryProcessStore } = await import('../services/process-service');
    const { FileService } = await import('../services/file-service');
    const { PortService, InMemoryPortStore } = await import('../services/port-service');
    const { GitService } = await import('../services/git-service');
    
    // Handlers
    const { SessionHandler } = await import('../handlers/session-handler');
    const { ExecuteHandler } = await import('../handlers/execute-handler');
    const { FileHandler } = await import('../handlers/file-handler');
    const { ProcessHandler } = await import('../handlers/process-handler');
    const { PortHandler } = await import('../handlers/port-handler');
    const { GitHandler } = await import('../handlers/git-handler');
    const { MiscHandler } = await import('../handlers/misc-handler');
    
    // Middleware
    const { CorsMiddleware } = await import('../middleware/cors');
    const { ValidationMiddleware } = await import('../middleware/validation');
    const { LoggingMiddleware } = await import('../middleware/logging');

    // Initialize infrastructure
    const logger = new ConsoleLogger();
    const security = new SecurityService(logger);
    const validator = new RequestValidator(security);
    
    // Initialize stores
    const sessionStore = new InMemorySessionStore();
    const processStore = new InMemoryProcessStore();
    const portStore = new InMemoryPortStore();
    
    // Initialize services
    const sessionService = new SessionService(sessionStore, logger);
    const processService = new ProcessService(processStore, logger);
    const fileService = new FileService(security, logger);
    const portService = new PortService(portStore, security, logger);
    const gitService = new GitService(security, logger);
    
    // Initialize handlers
    const sessionHandler = new SessionHandler(sessionService, logger);
    const executeHandler = new ExecuteHandler(processService, sessionService, logger);
    const fileHandler = new FileHandler(fileService, logger);
    const processHandler = new ProcessHandler(processService, logger);
    const portHandler = new PortHandler(portService, logger);
    const gitHandler = new GitHandler(gitService, logger);
    const miscHandler = new MiscHandler(logger);
    
    // Initialize middleware
    const corsMiddleware = new CorsMiddleware();
    const validationMiddleware = new ValidationMiddleware(validator);
    const loggingMiddleware = new LoggingMiddleware(logger);

    // Store all dependencies
    this.dependencies = {
      // Services
      sessionService,
      processService,
      fileService,
      portService,
      gitService,
      
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