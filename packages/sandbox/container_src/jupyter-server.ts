import {
  type Kernel,
  KernelManager,
  ServerConnection,
} from "@jupyterlab/services";
import type { IIOPubMessage } from "@jupyterlab/services/lib/kernel/messages";
import { v4 as uuidv4 } from "uuid";
import { processJupyterMessage } from "./mime-processor";

export interface JupyterContext {
  id: string;
  language: string;
  connection: Kernel.IKernelConnection;
  cwd: string;
  createdAt: Date;
  lastUsed: Date;
  pooled?: boolean; // Track if this context is from the pool
  inUse?: boolean; // Track if pooled context is currently in use
}

export interface CreateContextRequest {
  language?: string;
  cwd?: string;
  envVars?: Record<string, string>;
}

export interface ExecuteCodeRequest {
  context_id?: string;
  code: string;
  language?: string;
  env_vars?: Record<string, string>;
}

interface ContextPool {
  available: JupyterContext[];
  inUse: Set<string>; // context IDs currently in use
  minSize: number;
  maxSize: number;
  warming: boolean; // Track if pool is currently being warmed
}

export class JupyterServer {
  private kernelManager: KernelManager;
  private contexts = new Map<string, JupyterContext>();
  private defaultContexts = new Map<string, string>(); // language -> context_id
  private contextPools = new Map<string, ContextPool>(); // language -> pool

  constructor() {
    // Configure connection to local Jupyter server
    const serverSettings = ServerConnection.makeSettings({
      baseUrl: "http://localhost:8888",
      token: "",
      appUrl: "",
      wsUrl: "ws://localhost:8888",
      appendToken: false,
      init: {
        headers: {
          "Content-Type": "application/json",
        },
      },
    });

    this.kernelManager = new KernelManager({ serverSettings });
  }

  async initialize() {
    await this.kernelManager.ready;
    console.log("[JupyterServer] Kernel manager initialized");

    // Don't create default context during initialization - use lazy loading instead

    // Initialize pools for common languages (but don't warm them yet)
    this.initializePool("python", 0, 3);
    this.initializePool("javascript", 0, 2);
  }

  /**
   * Initialize a context pool for a specific language
   */
  private initializePool(language: string, minSize = 0, maxSize = 5) {
    const pool: ContextPool = {
      available: [],
      inUse: new Set(),
      minSize,
      maxSize,
      warming: false,
    };

    this.contextPools.set(language, pool);

    // Pre-warm contexts in background if minSize > 0
    if (minSize > 0) {
      setTimeout(() => this.warmPool(language, minSize), 0);
    }
  }

  /**
   * Enable pool warming for a language (called after Jupyter is ready)
   */
  async enablePoolWarming(language: string, minSize: number) {
    const pool = this.contextPools.get(language);
    if (!pool) {
      this.initializePool(language, minSize, 3);
      return;
    }

    // Update min size and warm if needed
    pool.minSize = minSize;
    const toWarm = minSize - pool.available.length;
    if (toWarm > 0) {
      await this.warmPool(language, toWarm);
    }
  }

  /**
   * Pre-warm a pool with the specified number of contexts
   */
  private async warmPool(language: string, count: number) {
    const pool = this.contextPools.get(language);
    if (!pool || pool.warming) return;

    pool.warming = true;
    console.log(`[JupyterServer] Pre-warming ${count} ${language} contexts`);

    try {
      const promises: Promise<JupyterContext>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(this.createPooledContext(language));
      }

      const contexts = await Promise.all(promises);
      pool.available.push(...contexts);
      console.log(
        `[JupyterServer] Pre-warmed ${contexts.length} ${language} contexts`
      );
    } catch (error) {
      console.error(
        `[JupyterServer] Error pre-warming ${language} pool:`,
        error
      );
    } finally {
      pool.warming = false;
    }
  }

  /**
   * Create a context specifically for the pool
   */
  private async createPooledContext(language: string): Promise<JupyterContext> {
    const context = await this.createContext({ language });
    context.pooled = true;
    context.inUse = false;
    return context;
  }

  /**
   * Get a context from the pool or create a new one
   */
  private async getPooledContext(
    language: string,
    cwd?: string,
    envVars?: Record<string, string>
  ): Promise<JupyterContext | null> {
    const pool = this.contextPools.get(language);
    if (!pool) return null;

    // Find an available context in the pool
    const availableContext = pool.available.find((ctx) => !ctx.inUse);

    if (availableContext) {
      // Mark as in use
      availableContext.inUse = true;
      pool.inUse.add(availableContext.id);

      // Remove from available list
      pool.available = pool.available.filter(
        (ctx) => ctx.id !== availableContext.id
      );

      // Update context properties if needed
      if (cwd && cwd !== availableContext.cwd) {
        await this.changeWorkingDirectory(availableContext, cwd);
        availableContext.cwd = cwd;
      }

      if (envVars) {
        await this.setEnvironmentVariables(availableContext, envVars);
      }

      availableContext.lastUsed = new Date();
      console.log(
        `[JupyterServer] Reusing pooled ${language} context ${availableContext.id}`
      );

      // Warm another context in background if we're below minSize
      if (pool.available.length < pool.minSize && !pool.warming) {
        setTimeout(() => this.warmPool(language, 1), 0);
      }

      return availableContext;
    }

    // No available context, check if we can create a new one
    if (pool.inUse.size < pool.maxSize) {
      console.log(
        `[JupyterServer] No pooled ${language} context available, creating new one`
      );
      return null; // Let the caller create a new context
    }

    // Pool is at max capacity
    console.log(
      `[JupyterServer] ${language} context pool at max capacity (${pool.maxSize})`
    );
    return null;
  }

  /**
   * Release a pooled context back to the pool
   */
  private releasePooledContext(context: JupyterContext) {
    if (!context.pooled) return;

    const pool = this.contextPools.get(context.language);
    if (!pool) return;

    // Mark as not in use
    context.inUse = false;
    pool.inUse.delete(context.id);

    // Add back to available list
    pool.available.push(context);

    console.log(
      `[JupyterServer] Released ${context.language} context ${context.id} back to pool`
    );
  }

  async createContext(req: CreateContextRequest): Promise<JupyterContext> {
    const language = req.language || "python";
    const cwd = req.cwd || "/workspace";

    // Try to get a context from the pool first
    const pooledContext = await this.getPooledContext(
      language,
      cwd,
      req.envVars
    );
    if (pooledContext) {
      // Add to active contexts map
      this.contexts.set(pooledContext.id, pooledContext);
      return pooledContext;
    }

    // Create a new context if pool didn't provide one
    const kernelModel = await this.kernelManager.startNew({
      name: this.getKernelName(language),
    });

    const connection = this.kernelManager.connectTo({ model: kernelModel });

    const context: JupyterContext = {
      id: uuidv4(),
      language,
      connection,
      cwd,
      createdAt: new Date(),
      lastUsed: new Date(),
    };

    this.contexts.set(context.id, context);

    // Set working directory
    if (cwd !== "/workspace") {
      await this.changeWorkingDirectory(context, cwd);
    }

    // Set environment variables if provided
    if (req.envVars) {
      await this.setEnvironmentVariables(context, req.envVars);
    }

    return context;
  }

  private async getOrCreateDefaultContext(
    language: string
  ): Promise<JupyterContext | undefined> {
    // Check if we already have a default context for this language
    const defaultContextId = this.defaultContexts.get(language);
    if (defaultContextId) {
      const context = this.contexts.get(defaultContextId);
      if (context) {
        return context;
      }
    }

    // Create new default context lazily
    console.log(
      `[JupyterServer] Creating default ${language} context on first use`
    );
    const context = await this.createContext({ language });
    this.defaultContexts.set(language, context.id);
    return context;
  }

  async executeCode(
    contextId: string | undefined,
    code: string,
    language?: string
  ): Promise<Response> {
    let context: JupyterContext | undefined;

    if (contextId) {
      context = this.contexts.get(contextId);
      if (!context) {
        return new Response(
          JSON.stringify({ error: `Context ${contextId} not found` }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } else {
      // Use or create default context for the language
      const lang = language || "python";
      context = await this.getOrCreateDefaultContext(lang);
    }

    if (!context) {
      return new Response(JSON.stringify({ error: "No context available" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Update last used
    context.lastUsed = new Date();

    // Execute with streaming
    return this.streamExecution(context.connection, code);
  }

  private async streamExecution(
    connection: Kernel.IKernelConnection,
    code: string
  ): Promise<Response> {
    const stream = new ReadableStream({
      async start(controller) {
        const future = connection.requestExecute({
          code,
          stop_on_error: false,
          store_history: true,
          silent: false,
          allow_stdin: false,
        });

        // Handle different message types
        future.onIOPub = (msg: IIOPubMessage) => {
          const result = processJupyterMessage(msg);
          if (result) {
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify(result)}\n`)
            );
          }
        };

        future.onReply = (msg: any) => {
          if (msg.content.status === "ok") {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  type: "execution_complete",
                  execution_count: msg.content.execution_count,
                })}\n`
              )
            );
          } else if (msg.content.status === "error") {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  type: "error",
                  ename: msg.content.ename,
                  evalue: msg.content.evalue,
                  traceback: msg.content.traceback,
                })}\n`
              )
            );
          }
          controller.close();
        };

        future.onStdin = (msg: any) => {
          // We don't support stdin for now
          console.warn("[JupyterServer] Stdin requested but not supported");
        };
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private getKernelName(language: string): string {
    const kernelMap: Record<string, string> = {
      python: "python3",
      javascript: "javascript",
      typescript: "javascript",
      js: "javascript",
      ts: "javascript",
    };
    return kernelMap[language.toLowerCase()] || "python3";
  }

  private async changeWorkingDirectory(context: JupyterContext, cwd: string) {
    const code =
      context.language === "python"
        ? `import os; os.chdir('${cwd}')`
        : `process.chdir('${cwd}')`;

    const future = context.connection.requestExecute({
      code,
      silent: true,
      store_history: false,
    });

    return future.done;
  }

  private async setEnvironmentVariables(
    context: JupyterContext,
    envVars: Record<string, string>
  ) {
    const commands: string[] = [];

    for (const [key, value] of Object.entries(envVars)) {
      if (context.language === "python") {
        commands.push(`import os; os.environ['${key}'] = '${value}'`);
      } else if (
        context.language === "javascript" ||
        context.language === "typescript"
      ) {
        commands.push(`process.env['${key}'] = '${value}'`);
      }
    }

    if (commands.length > 0) {
      const code = commands.join("\n");
      const future = context.connection.requestExecute({
        code,
        silent: true,
        store_history: false,
      });

      return future.done;
    }
  }

  async listContexts(): Promise<
    Array<{
      id: string;
      language: string;
      cwd: string;
      createdAt: Date;
      lastUsed: Date;
    }>
  > {
    return Array.from(this.contexts.values()).map((ctx) => ({
      id: ctx.id,
      language: ctx.language,
      cwd: ctx.cwd,
      createdAt: ctx.createdAt,
      lastUsed: ctx.lastUsed,
    }));
  }

  async deleteContext(contextId: string): Promise<void> {
    const context = this.contexts.get(contextId);
    if (!context) {
      throw new Error(`Context ${contextId} not found`);
    }

    // Remove from active contexts map
    this.contexts.delete(contextId);

    // Remove from default contexts if it was a default
    for (const [lang, id] of this.defaultContexts.entries()) {
      if (id === contextId) {
        this.defaultContexts.delete(lang);
        break;
      }
    }

    // If it's a pooled context, release it back to the pool
    if (context.pooled) {
      this.releasePooledContext(context);
    } else {
      // Only shutdown non-pooled contexts
      await context.connection.shutdown();
    }
  }

  async shutdown() {
    // Shutdown all active contexts
    for (const context of this.contexts.values()) {
      try {
        await context.connection.shutdown();
      } catch (error) {
        console.error("[JupyterServer] Error shutting down kernel:", error);
      }
    }

    // Shutdown all pooled contexts
    for (const pool of this.contextPools.values()) {
      for (const context of pool.available) {
        try {
          await context.connection.shutdown();
        } catch (error) {
          console.error(
            "[JupyterServer] Error shutting down pooled kernel:",
            error
          );
        }
      }
    }

    this.contexts.clear();
    this.defaultContexts.clear();
    this.contextPools.clear();
  }

  /**
   * Get pool statistics for monitoring
   */
  async getPoolStats(): Promise<
    Record<
      string,
      {
        available: number;
        inUse: number;
        total: number;
        minSize: number;
        maxSize: number;
        warming: boolean;
      }
    >
  > {
    const stats: Record<
      string,
      {
        available: number;
        inUse: number;
        total: number;
        minSize: number;
        maxSize: number;
        warming: boolean;
      }
    > = {};

    for (const [language, pool] of this.contextPools.entries()) {
      stats[language] = {
        available: pool.available.length,
        inUse: pool.inUse.size,
        total: pool.available.length + pool.inUse.size,
        minSize: pool.minSize,
        maxSize: pool.maxSize,
        warming: pool.warming,
      };
    }

    return stats;
  }
}
