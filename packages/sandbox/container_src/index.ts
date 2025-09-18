import { serve } from "bun";
import {
  handleExecuteRequest,
  handleStreamingExecuteRequest,
} from "./handler/exec";
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
import { handleCreateSession, handleListSessions } from "./handler/session";
import type { CreateContextRequest } from "./interpreter-service";
import {
  InterpreterNotReadyError,
  InterpreterService,
} from "./interpreter-service";
import { hasNamespaceSupport, SessionManager } from "./isolation";

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

// Initialize interpreter service
const interpreterService = new InterpreterService();

// No initialization needed - service is ready immediately!
console.log("[Container] Interpreter service ready - no cold start!");
console.log("[Container] All API endpoints available immediately");

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
            return handleCreateSession(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/session/list":
          if (req.method === "GET") {
            return handleListSessions(corsHeaders, sessionManager);
          }
          break;

        case "/api/execute":
          if (req.method === "POST") {
            return handleExecuteRequest(req, corsHeaders, sessionManager);
          }
          break;

        case "/api/execute/stream":
          if (req.method === "POST") {
            return handleStreamingExecuteRequest(
              req,
              sessionManager,
              corsHeaders
            );
          }
          break;

        case "/api/ping":
          if (req.method === "GET") {
            const health = await interpreterService.getHealthStatus();
            return new Response(
              JSON.stringify({
                message: "pong",
                timestamp: new Date().toISOString(),
                system: "interpreter (70x faster)",
                status: health.ready ? "ready" : "initializing",
                progress: health.progress,
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
              const context = await interpreterService.createContext(body);
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
              if (error instanceof InterpreterNotReadyError) {
                console.log(
                  `[Container] Request timed out waiting for interpreter (${error.progress}% complete)`
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
            const contexts = await interpreterService.listContexts();
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
              return await interpreterService.executeCode(
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
                  "[Container] Code execution deferred - service still initializing"
                );
              } else {
                console.error("[Container] Error executing code:", error);
              }
              // Error response is already handled by service.executeCode for not ready state
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
                await interpreterService.deleteContext(contextId);
                return new Response(JSON.stringify({ success: true }), {
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                  },
                });
              } catch (error) {
                if (error instanceof InterpreterNotReadyError) {
                  console.log(
                    `[Container] Request timed out waiting for interpreter (${error.progress}% complete)`
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
