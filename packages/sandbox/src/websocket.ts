/**
 * WebSocket helpers for Cloudflare Sandbox SDK
 */

import type { ISandbox, LogEvent, Process } from '@repo/shared';
import { parseSSEStream } from './sse-parser';

/**
 * Standard message types for sandbox WebSocket communication
 */
export interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

export interface ReadyMessage extends WebSocketMessage {
  type: 'ready';
  message: string;
  sandboxId?: string;
}

export interface OutputMessage extends WebSocketMessage {
  type: 'stdout' | 'stderr';
  data: string;
  pid?: number;
}

export interface ErrorMessage extends WebSocketMessage {
  type: 'error';
  message: string;
  code?: string;
  stack?: string;
}

export interface StatusMessage extends WebSocketMessage {
  type: 'status';
  status: string;
  message?: string;
}

export interface ResultMessage extends WebSocketMessage {
  type: 'result';
  data: any;
  executionTime?: number;
}

/**
 * Type-safe wrapper around WebSocket for sandbox communication
 *
 * Provides helpers for:
 * - Sending structured messages with automatic JSON serialization
 * - Streaming process logs to the client
 * - Running code with real-time output streaming
 * - Error handling and connection management
 */
export class SandboxWebSocket {
  constructor(
    private readonly server: WebSocket,
    private readonly sandbox: ISandbox
  ) {}

  /**
   * Send a type-safe message to the client
   */
  send(message: WebSocketMessage): void {
    try {
      this.server.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send WebSocket message:', error);
    }
  }

  /**
   * Send a ready notification
   */
  sendReady(message: string, sandboxId?: string): void {
    this.send({
      type: 'ready',
      message,
      sandboxId,
    } as ReadyMessage);
  }

  /**
   * Send output (stdout or stderr)
   */
  sendOutput(type: 'stdout' | 'stderr', data: string, pid?: number): void {
    this.send({
      type,
      data,
      pid,
    } as OutputMessage);
  }

  /**
   * Send an error message
   */
  sendError(error: Error | string, code?: string): void {
    const message = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'string' ? undefined : error.stack;

    this.send({
      type: 'error',
      message,
      code,
      stack,
    } as ErrorMessage);
  }

  /**
   * Send a status update
   */
  sendStatus(status: string, message?: string): void {
    this.send({
      type: 'status',
      status,
      message,
    } as StatusMessage);
  }

  /**
   * Send a result
   */
  sendResult(data: any, executionTime?: number): void {
    this.send({
      type: 'result',
      data,
      executionTime,
    } as ResultMessage);
  }

  /**
   * Stream process logs to the WebSocket client
   *
   * This bridges the sandbox's SSE log stream to WebSocket,
   * automatically parsing and forwarding log events.
   *
   * @param process - The process to stream logs from
   * @returns Promise that resolves when streaming completes
   */
  async streamProcessLogs(process: Process): Promise<void> {
    try {
      const logStream = await this.sandbox.streamProcessLogs(process.id);

      for await (const event of parseSSEStream<LogEvent>(logStream)) {
        if (event.type === 'stdout' || event.type === 'stderr') {
          this.sendOutput(event.type, event.data, process.pid);
        } else if (event.type === 'exit') {
          this.send({
            type: 'exit',
            pid: process.pid,
            exitCode: event.exitCode,
          });
        }
      }
    } catch (error) {
      this.sendError(error as Error);
    }
  }

  /**
   * Execute code with real-time output streaming
   *
   * @param code - Code to execute
   * @param options - Execution options including language and context
   * @returns Promise that resolves with the execution result
   */
  async runCodeWithStreaming(
    code: string,
    options?: { language?: 'python' | 'javascript'; context?: any; }
  ): Promise<any> {
    const startTime = Date.now();

    try {
      this.sendStatus('executing');

      // Use runCodeStream for streaming support
      const stream = await this.sandbox.runCodeStream(code, {
        language: options?.language || 'python',
        context: options?.context,
      });

      // Stream results back to client
      for await (const chunk of parseSSEStream<any>(stream)) {
        if (chunk.type === 'stdout' || chunk.type === 'stderr') {
          this.sendOutput(chunk.type, chunk.data);
        } else if (chunk.type === 'result') {
          const executionTime = Date.now() - startTime;
          this.sendResult(chunk.data, executionTime);
          return chunk.data;
        } else if (chunk.type === 'error') {
          this.sendError(chunk.data);
          throw new Error(chunk.data);
        }
      }
    } catch (error) {
      this.sendError(error as Error);
      throw error;
    }
  }

  /**
   * Start a process and stream its output
   *
   * @param command - Command to execute (including arguments)
   * @returns Promise that resolves with the process
   */
  async startProcessWithStreaming(command: string): Promise<Process> {
    try {
      const process = await this.sandbox.startProcess(command);

      this.send({
        type: 'process_started',
        pid: process.pid,
        id: process.id,
        command,
      });

      // Stream logs in the background
      this.streamProcessLogs(process).catch(error => {
        console.error('Error streaming process logs:', error);
      });

      return process;
    } catch (error) {
      this.sendError(error as Error);
      throw error;
    }
  }

  /**
   * Close the WebSocket connection
   */
  close(code?: number, reason?: string): void {
    try {
      this.server.close(code, reason);
    } catch (error) {
      console.error('Failed to close WebSocket:', error);
    }
  }

  /**
   * Get the underlying WebSocket server instance
   */
  get raw(): WebSocket {
    return this.server;
  }
}

/**
 * Options for creating a WebSocket handler
 */
export interface WebSocketHandlerOptions {
  /**
   * Custom sandbox ID (defaults to URL param or random UUID)
   */
  sandboxId?: string;

  /**
   * Callback when WebSocket is ready
   */
  onReady?: (ws: SandboxWebSocket, sandboxId: string) => void | Promise<void>;

  /**
   * Callback for incoming messages
   */
  onMessage?: (ws: SandboxWebSocket, message: any, event: MessageEvent) => void | Promise<void>;

  /**
   * Callback when WebSocket closes
   */
  onClose?: (ws: SandboxWebSocket, event: CloseEvent) => void | Promise<void>;

  /**
   * Callback for WebSocket errors
   */
  onError?: (ws: SandboxWebSocket, event: Event | ErrorEvent) => void | Promise<void>;
}

/**
 * Result of creating a WebSocket handler
 */
export interface WebSocketHandlerResult {
  /**
   * The Response object to return from fetch()
   */
  response: Response;

  /**
   * The SandboxWebSocket wrapper
   */
  websocket: SandboxWebSocket;

  /**
   * The sandbox instance
   */
  sandbox: ISandbox;

  /**
   * The sandbox ID used
   */
  sandboxId: string;
}

/**
 * Create a WebSocket handler with automatic setup and lifecycle management
 *
 * This is the main entry point for using WebSocket helpers. It:
 * - Creates a WebSocket pair
 * - Gets or creates a sandbox instance
 * - Wraps everything in a SandboxWebSocket
 * - Sets up event handlers
 * - Returns both the Response and the wrapper for further customization
 *
 * @example
 * ```typescript
 * async function handleWebSocket(request: Request, env: Env) {
 *   const { response, websocket, sandbox } = await createWebSocketHandler(
 *     request,
 *     env.Sandbox,
 *     {
 *       onReady: (ws, sandboxId) => {
 *         ws.sendReady('Connected to sandbox', sandboxId);
 *       },
 *       onMessage: async (ws, message) => {
 *         if (message.type === 'execute') {
 *           await ws.runPythonWithStreaming(message.code);
 *         }
 *       }
 *     }
 *   );
 *
 *   return response;
 * }
 * ```
 */
export async function createWebSocketHandler(
  request: Request,
  sandboxNamespace: DurableObjectNamespace,
  options: WebSocketHandlerOptions = {}
): Promise<WebSocketHandlerResult> {
  // Create WebSocket pair
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Get sandbox ID
  const url = new URL(request.url);
  const sandboxId =
    options.sandboxId ||
    url.searchParams.get('id') ||
    crypto.randomUUID();

  // Get sandbox instance
  const id = sandboxNamespace.idFromName(sandboxId);
  const stub = sandboxNamespace.get(id);
  const sandbox = stub as unknown as ISandbox;

  // Accept connection
  server.accept();

  // Create wrapper
  const ws = new SandboxWebSocket(server, sandbox);

  // Set up event handlers
  if (options.onMessage) {
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);
        await options.onMessage!(ws, message, event);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.sendError(error as Error);
      }
    });
  }

  if (options.onClose) {
    server.addEventListener('close', async (event) => {
      try {
        await options.onClose!(ws, event);
      } catch (error) {
        console.error('Error handling close:', error);
      }
    });
  }

  if (options.onError) {
    server.addEventListener('error', async (event) => {
      try {
        await options.onError!(ws, event);
      } catch (error) {
        console.error('Error handling error:', error);
      }
    });
  }

  // Call onReady callback
  if (options.onReady) {
    try {
      await options.onReady(ws, sandboxId);
    } catch (error) {
      console.error('Error in onReady callback:', error);
      ws.sendError(error as Error);
    }
  }

  // Return response and wrapper
  return {
    response: new Response(null, {
      status: 101,
      webSocket: client,
    }),
    websocket: ws,
    sandbox,
    sandboxId,
  };
}
