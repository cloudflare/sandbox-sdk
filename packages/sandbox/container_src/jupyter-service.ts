import { existsSync } from "node:fs";
import { CircuitBreaker } from "./circuit-breaker";
import { type CreateContextRequest, JupyterServer } from "./jupyter-server";

interface PoolStats {
  available: number;
  inUse: number;
  total: number;
  minSize: number;
  maxSize: number;
  warming: boolean;
}

interface CircuitBreakerState {
  state: string;
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

export interface JupyterHealthStatus {
  ready: boolean;
  initializing: boolean;
  error?: string;
  checks?: {
    httpApi: boolean;
    kernelManager: boolean;
    markerFile: boolean;
    kernelSpawn?: boolean;
    websocket?: boolean;
  };
  timestamp: number;
  performance?: {
    poolStats?: Record<string, PoolStats>;
    activeContexts?: number;
    uptime?: number;
    circuitBreakers?: {
      contextCreation: CircuitBreakerState;
      codeExecution: CircuitBreakerState;
      kernelCommunication: CircuitBreakerState;
    };
  };
}

/**
 * Wrapper service that provides graceful degradation for Jupyter functionality
 */
export class JupyterService {
  private jupyterServer: JupyterServer;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private initError: Error | null = null;
  private startTime = Date.now();
  private circuitBreakers: {
    contextCreation: CircuitBreaker;
    codeExecution: CircuitBreaker;
    kernelCommunication: CircuitBreaker;
  };

  constructor() {
    this.jupyterServer = new JupyterServer();

    // Initialize circuit breakers for different operations
    this.circuitBreakers = {
      contextCreation: new CircuitBreaker({
        name: "context-creation",
        threshold: 3,
        timeout: 60000, // 1 minute
      }),
      codeExecution: new CircuitBreaker({
        name: "code-execution",
        threshold: 5,
        timeout: 30000, // 30 seconds
      }),
      kernelCommunication: new CircuitBreaker({
        name: "kernel-communication",
        threshold: 10,
        timeout: 20000, // 20 seconds
      }),
    };
  }

  /**
   * Initialize Jupyter server with retry logic
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.initPromise) {
      this.initPromise = this.doInitialize()
        .then(() => {
          this.initialized = true;
          console.log("[JupyterService] Initialization complete");
        })
        .catch((err) => {
          this.initError = err;
          // Don't null out initPromise on error - keep it so we can return the same error
          console.error("[JupyterService] Initialization failed:", err);
          throw err;
        });
    }

    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Wait for Jupyter marker file or timeout
    const markerCheckPromise = this.waitForMarkerFile();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error("Jupyter initialization timeout")),
        60000
      );
    });

    try {
      await Promise.race([markerCheckPromise, timeoutPromise]);
      console.log("[JupyterService] Jupyter process detected via marker file");
    } catch (error) {
      console.log(
        "[JupyterService] Marker file not found yet - proceeding with initialization"
      );
    }

    // Initialize Jupyter server
    await this.jupyterServer.initialize();

    // Pre-warm context pools in background after Jupyter is ready
    this.warmContextPools();
  }

  /**
   * Pre-warm context pools for better performance
   */
  private async warmContextPools() {
    try {
      console.log(
        "[JupyterService] Pre-warming context pools for better performance"
      );

      // Enable pool warming with min sizes
      await this.jupyterServer.enablePoolWarming("python", 1);
      await this.jupyterServer.enablePoolWarming("javascript", 1);
    } catch (error) {
      console.error("[JupyterService] Error pre-warming context pools:", error);
    }
  }

  private async waitForMarkerFile(): Promise<void> {
    const markerPath = "/tmp/jupyter-ready";
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes with 1s intervals

    while (attempts < maxAttempts) {
      if (existsSync(markerPath)) {
        return;
      }
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("Marker file not found within timeout");
  }

  /**
   * Get current health status
   */
  async getHealthStatus(): Promise<JupyterHealthStatus> {
    const status: JupyterHealthStatus = {
      ready: this.initialized,
      initializing: this.initPromise !== null && !this.initialized,
      timestamp: Date.now(),
    };

    if (this.initError) {
      status.error = this.initError.message;
    }

    // Detailed health checks
    if (this.initialized || this.initPromise) {
      status.checks = {
        httpApi: await this.checkHttpApi(),
        kernelManager: this.initialized,
        markerFile: existsSync("/tmp/jupyter-ready"),
      };

      // Advanced health checks only if fully initialized
      if (this.initialized) {
        const advancedChecks = await this.performAdvancedHealthChecks();
        status.checks.kernelSpawn = advancedChecks.kernelSpawn;
        status.checks.websocket = advancedChecks.websocket;

        // Performance metrics
        status.performance = {
          poolStats: await this.jupyterServer.getPoolStats(),
          activeContexts: (await this.jupyterServer.listContexts()).length,
          uptime: Date.now() - this.startTime,
        };
      }
    }

    // Add circuit breaker status
    if (status.performance) {
      status.performance.circuitBreakers = {
        contextCreation: this.circuitBreakers.contextCreation.getState(),
        codeExecution: this.circuitBreakers.codeExecution.getState(),
        kernelCommunication:
          this.circuitBreakers.kernelCommunication.getState(),
      };
    }

    return status;
  }

  private async checkHttpApi(): Promise<boolean> {
    try {
      const response = await fetch("http://localhost:8888/api", {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Perform advanced health checks including kernel spawn and WebSocket
   */
  private async performAdvancedHealthChecks(): Promise<{
    kernelSpawn: boolean;
    websocket: boolean;
  }> {
    const checks = {
      kernelSpawn: false,
      websocket: false,
    };

    try {
      // Test kernel spawn with timeout
      const testContext = await Promise.race([
        this.jupyterServer.createContext({ language: "python" }),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("Kernel spawn timeout")), 5000)
        ),
      ]);

      if (testContext) {
        checks.kernelSpawn = true;

        // Test WebSocket by executing simple code
        try {
          const result = await Promise.race([
            this.jupyterServer.executeCode(
              testContext.id,
              "print('health_check')"
            ),
            new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error("WebSocket timeout")), 3000)
            ),
          ]);

          checks.websocket = result !== null;
        } catch {
          // WebSocket test failed
        }

        // Clean up test context
        try {
          await this.jupyterServer.deleteContext(testContext.id);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      console.log("[JupyterService] Advanced health check failed:", error);
    }

    return checks;
  }

  /**
   * Ensure Jupyter is initialized before proceeding
   * This will wait for initialization to complete or fail
   */
  private async ensureInitialized(timeoutMs: number = 30000): Promise<void> {
    if (this.initialized) return;

    // Start initialization if not already started
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    // Wait for initialization with timeout
    try {
      await Promise.race([
        this.initPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("Timeout waiting for Jupyter initialization")),
            timeoutMs
          )
        ),
      ]);
    } catch (error) {
      // If it's a timeout and Jupyter is still initializing, throw a retryable error
      if (
        error instanceof Error &&
        error.message.includes("Timeout") &&
        !this.initError
      ) {
        throw new JupyterNotReadyError(
          "Jupyter is taking longer than expected to initialize. Please try again.",
          {
            retryAfter: 10,
            progress: this.getInitializationProgress(),
          }
        );
      }
      // If initialization actually failed, throw the real error
      throw new Error(
        `Jupyter initialization failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Create context - will wait for Jupyter if still initializing
   */
  async createContext(req: CreateContextRequest): Promise<any> {
    if (!this.initialized) {
      console.log(
        "[JupyterService] Context creation requested while Jupyter is initializing - waiting..."
      );
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(
        `[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with context creation`
      );
    }

    // Use circuit breaker for context creation
    return await this.circuitBreakers.contextCreation.execute(async () => {
      return await this.jupyterServer.createContext(req);
    });
  }

  /**
   * Execute code - will wait for Jupyter if still initializing
   */
  async executeCode(
    contextId: string | undefined,
    code: string,
    language?: string
  ): Promise<Response> {
    if (!this.initialized) {
      console.log(
        "[JupyterService] Code execution requested while Jupyter is initializing - waiting..."
      );
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(
        `[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with code execution`
      );
    }

    // Use circuit breaker for code execution
    return await this.circuitBreakers.codeExecution.execute(async () => {
      return await this.jupyterServer.executeCode(contextId, code, language);
    });
  }

  /**
   * List contexts with graceful degradation
   */
  async listContexts(): Promise<any[]> {
    if (!this.initialized) {
      return [];
    }
    return await this.jupyterServer.listContexts();
  }

  /**
   * Delete context - will wait for Jupyter if still initializing
   */
  async deleteContext(contextId: string): Promise<void> {
    if (!this.initialized) {
      console.log(
        "[JupyterService] Context deletion requested while Jupyter is initializing - waiting..."
      );
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(
        `[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with context deletion`
      );
    }

    // Use circuit breaker for kernel communication
    return await this.circuitBreakers.kernelCommunication.execute(async () => {
      return await this.jupyterServer.deleteContext(contextId);
    });
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    if (this.initialized) {
      await this.jupyterServer.shutdown();
    }
  }

  /**
   * Get initialization progress
   */
  private getInitializationProgress(): number {
    if (this.initialized) return 100;
    if (!this.initPromise) return 0;

    const elapsed = Date.now() - this.startTime;
    const estimatedTotal = 20000; // 20 seconds estimated
    return Math.min(95, Math.round((elapsed / estimatedTotal) * 100));
  }
}

/**
 * Error thrown when Jupyter is not ready yet
 * This matches the interface of the SDK's JupyterNotReadyError
 */
export class JupyterNotReadyError extends Error {
  public readonly retryAfter: number;
  public readonly progress?: number;

  constructor(
    message: string,
    options?: { retryAfter?: number; progress?: number }
  ) {
    super(message);
    this.name = "JupyterNotReadyError";
    this.retryAfter = options?.retryAfter || 5;
    this.progress = options?.progress;
  }
}
