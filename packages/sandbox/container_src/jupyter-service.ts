import { existsSync } from "node:fs";
import { type CreateContextRequest, JupyterServer } from "./jupyter-server";

export interface JupyterHealthStatus {
  ready: boolean;
  initializing: boolean;
  error?: string;
  checks?: {
    httpApi: boolean;
    kernelManager: boolean;
    markerFile: boolean;
  };
  timestamp: number;
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

  constructor() {
    this.jupyterServer = new JupyterServer();
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
      setTimeout(() => reject(new Error("Jupyter initialization timeout")), 60000);
    });

    try {
      await Promise.race([markerCheckPromise, timeoutPromise]);
      console.log("[JupyterService] Jupyter process detected via marker file");
    } catch (error) {
      console.log("[JupyterService] Marker file not found yet - proceeding with initialization");
    }

    // Initialize Jupyter server
    await this.jupyterServer.initialize();
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
          setTimeout(() => reject(new Error("Timeout waiting for Jupyter initialization")), timeoutMs)
        )
      ]);
    } catch (error) {
      // If it's a timeout and Jupyter is still initializing, throw a retryable error
      if (error instanceof Error && error.message.includes("Timeout") && !this.initError) {
        throw new JupyterNotReadyError(
          "Jupyter is taking longer than expected to initialize. Please try again.",
          { 
            retryAfter: 10,
            progress: this.getInitializationProgress()
          }
        );
      }
      // If initialization actually failed, throw the real error
      throw new Error(`Jupyter initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create context - will wait for Jupyter if still initializing
   */
  async createContext(req: CreateContextRequest): Promise<any> {
    if (!this.initialized) {
      console.log("[JupyterService] Context creation requested while Jupyter is initializing - waiting...");
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(`[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with context creation`);
    }
    return await this.jupyterServer.createContext(req);
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
      console.log("[JupyterService] Code execution requested while Jupyter is initializing - waiting...");
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(`[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with code execution`);
    }
    return await this.jupyterServer.executeCode(contextId, code, language);
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
      console.log("[JupyterService] Context deletion requested while Jupyter is initializing - waiting...");
      const startWait = Date.now();
      await this.ensureInitialized();
      const waitTime = Date.now() - startWait;
      console.log(`[JupyterService] Jupyter ready after ${waitTime}ms wait - proceeding with context deletion`);
    }
    return await this.jupyterServer.deleteContext(contextId);
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

  constructor(message: string, options?: { retryAfter?: number; progress?: number }) {
    super(message);
    this.name = "JupyterNotReadyError";
    this.retryAfter = options?.retryAfter || 5;
    this.progress = options?.progress;
  }
}

