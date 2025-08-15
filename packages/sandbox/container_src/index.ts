import { randomBytes } from "node:crypto";
import { serve } from "bun";
import {
  handleDeleteFileRequest,
  handleListFilesRequest,
  handleMkdirRequest,
  handleMoveFileRequest,
  handleReadFileRequest,
  handleRenameFileRequest,
  handleWriteFileRequest,
} from "./handler/file";
import { handleGitCheckoutRequest } from "./handler/git";
import {
  handleExposePortRequest,
  handleGetExposedPortsRequest,
  handleProxyRequest,
  handleUnexposePortRequest,
} from "./handler/ports";
import {
  handleGetProcessLogsRequest,
  handleGetProcessRequest,
  handleKillAllProcessesRequest,
  handleKillProcessRequest,
  handleListProcessesRequest,
  handleStartProcessRequest,
  handleStreamProcessLogsRequest,
} from "./handler/process";
import { hasNamespaceSupport, SessionManager } from "./isolation";
import type { CreateContextRequest } from "./jupyter-server";
import { JupyterNotReadyError, JupyterService } from "./jupyter-service";
import type { CreateSessionRequest, SessionExecRequest } from "./types";

// In-memory storage for exposed ports
const exposedPorts = new Map<number, { name?: string; exposedAt: Date }>();

// Check isolation capabilities on startup
const isolationAvailable = hasNamespaceSupport();
console.log(
  `[Container] Process isolation: ${
    isolationAvailable
      ? "ENABLED (production mode)"
      : "DISABLED (development mode)"
  }`
);

// Session manager for secure execution with isolation
const sessionManager = new SessionManager();

// Graceful shutdown handler
const SHUTDOWN_GRACE_PERIOD_MS = 5000; // Grace period for cleanup (5 seconds for proper async cleanup)

process.on("SIGTERM", async () => {
  console.log("[Container] SIGTERM received, cleaning up sessions...");
  await sessionManager.destroyAll();
  setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_GRACE_PERIOD_MS);
});

process.on("SIGINT", async () => {
  console.log("[Container] SIGINT received, cleaning up sessions...");
  await sessionManager.destroyAll();
  setTimeout(() => {
    process.exit(0);
  }, SHUTDOWN_GRACE_PERIOD_MS);
});

// Cleanup on uncaught exceptions (log but still exit)
process.on("uncaughtException", async (error) => {
  console.error("[Container] Uncaught exception:", error);
  await sessionManager.destroyAll();
  process.exit(1);
});

// Initialize Jupyter service with graceful degradation
const jupyterService = new JupyterService();

// Start Jupyter initialization in background (non-blocking)
console.log("[Container] Starting Jupyter initialization in background...");
console.log(
  "[Container] API endpoints are available immediately. Jupyter-dependent features will be available shortly."
);

jupyterService
  .initialize()
  .then(() => {
    console.log(
      "[Container] Jupyter fully initialized - all features available"
    );
  })
  .catch((error) => {
    console.error("[Container] Jupyter initialization failed:", error.message);
    console.error(
      "[Container] The API will continue in degraded mode without code execution capabilities"
    );
  });

const server = serve({
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    console.log(`[Container] Incoming ${req.method} request to ${pathname}`);

    // Handle CORS
    const corsHeaders = {
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    };

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      console.log(`[Container] Handling CORS preflight for ${pathname}`);
      return new Response(null, { headers: corsHeaders, status: 200 });
    }

    try {
      // Handle different routes
      console.log(`[Container] Processing ${req.method} ${pathname}`);
      switch (pathname) {
        case "/":
          return new Response("Hello from Bun server! 🚀", {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              ...corsHeaders,
            },
          });

        case "/api/session/create":
          if (req.method === "POST") {
            try {
              const body = (await req.json()) as CreateSessionRequest;
              const { id, env, cwd, isolation } = body;

              if (!id) {
                return new Response(
                  JSON.stringify({ error: "Session ID is required" }),
                  {
                    status: 400,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }

              const session = await sessionManager.createSession({
                id,
                env: env || {},
                cwd: cwd || "/workspace",
                isolation: isolation !== false,
              });

              console.log(`[Container] Session '${id}' created successfully`);
              console.log(
                `[Container] Available sessions now: ${sessionManager
                  .listSessions()
                  .join(", ")}`
              );

              return new Response(
                JSON.stringify({
                  success: true,
                  id,
                  message: `Session '${id}' created with${
                    isolation !== false ? "" : "out"
                  } isolation`,
                }),
                {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            } catch (error) {
              console.error("[Container] Failed to create session:", error);
              return new Response(
                JSON.stringify({
                  error: "Failed to create session",
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          }
          break;

        case "/api/session/list":
          if (req.method === "GET") {
            const sessionList = sessionManager.listSessions();
            return new Response(
              JSON.stringify({
                count: sessionList.length,
                sessions: sessionList,
                timestamp: new Date().toISOString(),
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/execute":
          if (req.method === "POST") {
            try {
              const body = (await req.json()) as SessionExecRequest;
              const { id, command } = body;

              console.log(
                `[Container] Session exec request for '${id}': ${command}`
              );

              if (!id || !command) {
                return new Response(
                  JSON.stringify({
                    error: "Session ID and command are required",
                  }),
                  {
                    status: 400,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }

              const session = sessionManager.getSession(id);
              if (!session) {
                console.error(`[Container] Session '${id}' not found!`);
                const availableSessions = sessionManager.listSessions();
                console.log(
                  `[Container] Available sessions: ${
                    availableSessions.join(", ") || "none"
                  }`
                );

                return new Response(
                  JSON.stringify({
                    error: `Session '${id}' not found`,
                    availableSessions,
                  }),
                  {
                    status: 404,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }

              const result = await session.exec(command);

              return new Response(JSON.stringify(result), {
                headers: { "Content-Type": "application/json", ...corsHeaders },
              });
            } catch (error) {
              console.error("[Container] Session exec failed:", error);
              return new Response(
                JSON.stringify({
                  error: "Command execution failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          }
          break;
  
        case "/api/execute/stream":
          if (req.method === "POST") {
            try {
              const body = (await req.json()) as SessionExecRequest;
              const { id, command } = body;

              console.log(
                `[Container] Session streaming exec request for '${id}': ${command}`
              );

              if (!id || !command) {
                return new Response(
                  JSON.stringify({
                    error: "Session ID and command are required",
                  }),
                  {
                    status: 400,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }

              const session = sessionManager.getSession(id);
              if (!session) {
                console.error(`[Container] Session '${id}' not found!`);
                const availableSessions = sessionManager.listSessions();

                return new Response(
                  JSON.stringify({
                    error: `Session '${id}' not found`,
                    availableSessions,
                  }),
                  {
                    status: 404,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }

              // Create a streaming response using the actual streaming method
              const stream = new ReadableStream({
                async start(controller) {
                  try {
                    // Use the streaming generator method
                    for await (const event of session.execStream(command)) {
                      // Forward each event as SSE
                      controller.enqueue(
                        new TextEncoder().encode(
                          `data: ${JSON.stringify(event)}\n\n`
                        )
                      );
                    }
                    controller.close();
                  } catch (error) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify({
                          type: "error",
                          message:
                            error instanceof Error
                              ? error.message
                              : String(error),
                        })}\n\n`
                      )
                    );
                    controller.close();
                  }
                },
              });

              return new Response(stream, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                  ...corsHeaders,
                },
              });
            } catch (error) {
              console.error("[Container] Session stream exec failed:", error);
              return new Response(
                JSON.stringify({
                  error: "Stream execution failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          }
          break;


        case "/api/ping":
          if (req.method === "GET") {
            const health = await jupyterService.getHealthStatus();
            return new Response(
              JSON.stringify({
                message: "pong",
                timestamp: new Date().toISOString(),
                jupyter: health.ready
                  ? "ready"
                  : health.initializing
                  ? "initializing"
                  : "not ready",
                jupyterHealth: health,
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/commands":
          if (req.method === "GET") {
            return new Response(
              JSON.stringify({
                availableCommands: [
                  "ls",
                  "pwd",
                  "echo",
                  "cat",
                  "grep",
                  "find",
                  "whoami",
                  "date",
                  "uptime",
                  "ps",
                  "top",
                  "df",
                  "du",
                  "free",
                ],
                timestamp: new Date().toISOString(),
              }),
              {
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          break;

        case "/api/git/checkout":
          if (req.method === "POST") {
            return handleGitCheckoutRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/mkdir":
          if (req.method === "POST") {
            return handleMkdirRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/write":
          if (req.method === "POST") {
            return handleWriteFileRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/read":
          if (req.method === "POST") {
            return handleReadFileRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/delete":
          if (req.method === "POST") {
            return handleDeleteFileRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/rename":
          if (req.method === "POST") {
            return handleRenameFileRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/move":
          if (req.method === "POST") {
            return handleMoveFileRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/list-files":
          if (req.method === "POST") {
            return handleListFilesRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/expose-port":
          if (req.method === "POST") {
            return handleExposePortRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/unexpose-port":
          if (req.method === "DELETE") {
            return handleUnexposePortRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/exposed-ports":
          if (req.method === "GET") {
            return handleGetExposedPortsRequest(exposedPorts, req, corsHeaders);
          }
          break;

        case "/api/process/start":
          if (req.method === "POST") {
            return handleStartProcessRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/process/list":
          if (req.method === "GET") {
            return handleListProcessesRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/process/kill-all":
          if (req.method === "DELETE") {
            return handleKillAllProcessesRequest(
              req,
              corsHeaders,
              sessionManager
            );
          }
          break;

        case "/api/contexts":
          if (req.method === "POST") {
            try {
              const body = (await req.json()) as CreateContextRequest;
              const context = await jupyterService.createContext(body);
              return new Response(
                JSON.stringify({
                  id: context.id,
                  language: context.language,
                  cwd: context.cwd,
                  createdAt: context.createdAt,
                  lastUsed: context.lastUsed,
                }),
                {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            } catch (error) {
              if (error instanceof JupyterNotReadyError) {
                console.log(
                  `[Container] Request timed out waiting for Jupyter (${error.progress}% complete)`
                );
                return new Response(
                  JSON.stringify({
                    error: error.message,
                    status: "initializing",
                    progress: error.progress,
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": String(error.retryAfter),
                      ...corsHeaders,
                    },
                  }
                );
              }

              // Check if it's a circuit breaker error
              if (
                error instanceof Error &&
                error.message.includes("Circuit breaker is open")
              ) {
                console.log(
                  "[Container] Circuit breaker is open:",
                  error.message
                );
                return new Response(
                  JSON.stringify({
                    error:
                      "Service temporarily unavailable due to high error rate. Please try again later.",
                    status: "circuit_open",
                    details: error.message,
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": "60",
                      ...corsHeaders,
                    },
                  }
                );
              }

              // Only log actual errors with stack traces
              console.error("[Container] Error creating context:", error);
              return new Response(
                JSON.stringify({
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to create context",
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          } else if (req.method === "GET") {
            const contexts = await jupyterService.listContexts();
            return new Response(JSON.stringify({ contexts }), {
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            });
          }
          break;

        case "/api/execute/code":
          if (req.method === "POST") {
            try {
              const body = (await req.json()) as {
                context_id: string;
                code: string;
                language?: string;
              };
              return await jupyterService.executeCode(
                body.context_id,
                body.code,
                body.language
              );
            } catch (error) {
              // Check if it's a circuit breaker error
              if (
                error instanceof Error &&
                error.message.includes("Circuit breaker is open")
              ) {
                console.log(
                  "[Container] Circuit breaker is open for code execution:",
                  error.message
                );
                return new Response(
                  JSON.stringify({
                    error:
                      "Service temporarily unavailable due to high error rate. Please try again later.",
                    status: "circuit_open",
                    details: error.message,
                  }),
                  {
                    status: 503,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": "30",
                      ...corsHeaders,
                    },
                  }
                );
              }

              // Don't log stack traces for expected initialization state
              if (
                error instanceof Error &&
                error.message.includes("initializing")
              ) {
                console.log(
                  "[Container] Code execution deferred - Jupyter still initializing"
                );
              } else {
                console.error("[Container] Error executing code:", error);
              }
              // Error response is already handled by jupyterService.executeCode for not ready state
              return new Response(
                JSON.stringify({
                  error:
                    error instanceof Error
                      ? error.message
                      : "Failed to execute code",
                }),
                {
                  status: 500,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                }
              );
            }
          }
          break;

        default:
          // Handle dynamic routes for contexts
          if (
            pathname.startsWith("/api/contexts/") &&
            pathname.split("/").length === 4
          ) {
            const contextId = pathname.split("/")[3];
            if (req.method === "DELETE") {
              try {
                await jupyterService.deleteContext(contextId);
                return new Response(JSON.stringify({ success: true }), {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                });
              } catch (error) {
                if (error instanceof JupyterNotReadyError) {
                  console.log(
                    `[Container] Request timed out waiting for Jupyter (${error.progress}% complete)`
                  );
                  return new Response(
                    JSON.stringify({
                      error: error.message,
                      status: "initializing",
                      progress: error.progress,
                    }),
                    {
                      status: 503,
                      headers: {
                        "Content-Type": "application/json",
                        "Retry-After": "5",
                        ...corsHeaders,
                      },
                    }
                  );
                }
                return new Response(
                  JSON.stringify({
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to delete context",
                  }),
                  {
                    status:
                      error instanceof Error &&
                      error.message.includes("not found")
                        ? 404
                        : 500,
                    headers: {
                      "Content-Type": "application/json",
                      ...corsHeaders,
                    },
                  }
                );
              }
            }
          }

          // Handle dynamic routes for individual processes
          if (pathname.startsWith("/api/process/")) {
            const segments = pathname.split("/");
            if (segments.length >= 4) {
              const processId = segments[3];
              const action = segments[4]; // Optional: logs, stream, etc.

              if (!action && req.method === "GET") {
                return handleGetProcessRequest(
                  req,
                  corsHeaders,
                  processId,
                  sessionManager
                );
              } else if (!action && req.method === "DELETE") {
                return handleKillProcessRequest(
                  req,
                  corsHeaders,
                  processId,
                  sessionManager
                );
              } else if (action === "logs" && req.method === "GET") {
                return handleGetProcessLogsRequest(
                  req,
                  corsHeaders,
                  processId,
                  sessionManager
                );
              } else if (action === "stream" && req.method === "GET") {
                return handleStreamProcessLogsRequest(
                  req,
                  corsHeaders,
                  processId,
                  sessionManager
                );
              }
            }
          }
          // Check if this is a proxy request for an exposed port
          if (pathname.startsWith("/proxy/")) {
            return handleProxyRequest(exposedPorts, req, corsHeaders);
          }

          console.log(`[Container] Route not found: ${pathname}`);
          return new Response("Not Found", {
            headers: corsHeaders,
            status: 404,
          });
      }
    } catch (error) {
      console.error(
        `[Container] Error handling ${req.method} ${pathname}:`,
        error
      );
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 500,
        }
      );
    }
  },
  hostname: "0.0.0.0",
  port: 3000,
  // We don't need this, but typescript complains
  websocket: { async message() {} },
});

console.log(`🚀 Bun server running on http://0.0.0.0:${server.port}`);
console.log(`📡 HTTP API endpoints available:`);
console.log(`   POST /api/session/create - Create a new session`);
console.log(`   GET  /api/session/list - List all sessions`);
console.log(`   POST /api/execute - Execute a command (non-streaming)`);
console.log(`   POST /api/execute/stream - Execute a command (streaming)`);
console.log(`   POST /api/git/checkout - Checkout a git repository`);
console.log(`   POST /api/mkdir - Create a directory`);
console.log(`   POST /api/write - Write a file`);
console.log(`   POST /api/read - Read a file`);
console.log(`   POST /api/delete - Delete a file`);
console.log(`   POST /api/rename - Rename a file`);
console.log(`   POST /api/move - Move a file`);
console.log(`   POST /api/expose-port - Expose a port for external access`);
console.log(`   DELETE /api/unexpose-port - Unexpose a port`);
console.log(`   GET  /api/exposed-ports - List exposed ports`);
console.log(`   POST /api/process/start - Start a background process`);
console.log(`   GET  /api/process/list - List all processes`);
console.log(`   GET  /api/process/{id} - Get process status`);
console.log(`   DELETE /api/process/{id} - Kill a process`);
console.log(`   GET  /api/process/{id}/logs - Get process logs`);
console.log(`   GET  /api/process/{id}/stream - Stream process logs (SSE)`);
console.log(`   DELETE /api/process/kill-all - Kill all processes`);
console.log(`   GET  /proxy/{port}/* - Proxy requests to exposed ports`);
console.log(`   POST /api/contexts - Create a code execution context`);
console.log(`   GET  /api/contexts - List all contexts`);
console.log(`   DELETE /api/contexts/{id} - Delete a context`);
console.log(
  `   POST /api/execute/code - Execute code in a context (streaming)`
);
console.log(`   GET  /api/ping - Health check`);
console.log(`   GET  /api/commands - List available commands`);
