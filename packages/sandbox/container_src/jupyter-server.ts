import { type Kernel, KernelManager, ServerConnection } from "@jupyterlab/services";
import type { 
  IDisplayDataMsg,
  IErrorMsg, 
  IExecuteResultMsg,
  IIOPubMessage,
  IStreamMsg
} from "@jupyterlab/services/lib/kernel/messages";
import { 
  isDisplayDataMsg,
  isErrorMsg, 
  isExecuteResultMsg,
  isStreamMsg
} from "@jupyterlab/services/lib/kernel/messages";
import { v4 as uuidv4 } from "uuid";
import type { ExecutionResult } from "./mime-processor";
import { processJupyterMessage } from "./mime-processor";

export interface JupyterContext {
  id: string;
  language: string;
  connection: Kernel.IKernelConnection;
  cwd: string;
  createdAt: Date;
  lastUsed: Date;
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

export class JupyterServer {
  private kernelManager: KernelManager;
  private contexts = new Map<string, JupyterContext>();
  private defaultContexts = new Map<string, string>(); // language -> context_id

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
          'Content-Type': 'application/json'
        }
      }
    });

    this.kernelManager = new KernelManager({ serverSettings });
  }

  async initialize() {
    await this.kernelManager.ready;
    console.log("[JupyterServer] Kernel manager initialized");

    // Create default Python context
    const pythonContext = await this.createContext({ language: "python" });
    this.defaultContexts.set("python", pythonContext.id);
    console.log(
      "[JupyterServer] Default Python context created:",
      pythonContext.id
    );
  }

  async createContext(req: CreateContextRequest): Promise<JupyterContext> {
    const language = req.language || "python";
    const cwd = req.cwd || "/workspace";

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
    } else if (language) {
      // Use default context for the language
      const defaultContextId = this.defaultContexts.get(language);
      if (defaultContextId) {
        context = this.contexts.get(defaultContextId);
      }

      // Create new default context if needed
      if (!context) {
        context = await this.createContext({ language });
        this.defaultContexts.set(language, context.id);
      }
    } else {
      // Use default Python context
      const pythonContextId = this.defaultContexts.get("python");
      context = pythonContextId
        ? this.contexts.get(pythonContextId)
        : undefined;
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

    // Shutdown the kernel
    await context.connection.shutdown();

    // Remove from maps
    this.contexts.delete(contextId);

    // Remove from default contexts if it was a default
    for (const [lang, id] of this.defaultContexts.entries()) {
      if (id === contextId) {
        this.defaultContexts.delete(lang);
        break;
      }
    }
  }

  async shutdown() {
    // Shutdown all kernels
    for (const context of this.contexts.values()) {
      try {
        await context.connection.shutdown();
      } catch (error) {
        console.error("[JupyterServer] Error shutting down kernel:", error);
      }
    }

    this.contexts.clear();
    this.defaultContexts.clear();
  }
}

