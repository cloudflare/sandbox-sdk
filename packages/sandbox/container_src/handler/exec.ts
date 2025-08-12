import { type SpawnOptions, spawn } from "node:child_process";
import type { ExecuteResponse } from "../../src/types";
import type { ExecuteOptions, ExecuteRequest } from "../types";
import type { SessionManager } from "../utils/isolation";

function executeCommand(
  command: string,
  options: ExecuteOptions,
): Promise<Omit<ExecuteResponse, 'command' | 'timestamp'>> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"] as const,
      detached: options.background || false,
      cwd: options.cwd || "/workspace", // Default to clean /workspace directory
      env: options.env ? { ...process.env, ...options.env } : process.env
    };

    const child = spawn(command, spawnOptions);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    if (options.background) {
      // For background processes, unref and return quickly
      child.unref();

      // Collect initial output for 100ms then return
      setTimeout(() => {
        resolve({
          exitCode: 0, // Process is still running
          stderr,
          stdout,
          success: true,
        });
      }, 100);

      // Still handle errors
      child.on("error", (error) => {
        console.error(`[Exec] Background process error: ${command}`, error);
        // Don't reject since we might have already resolved
      });
    } else {
      // Normal synchronous execution
      child.on("close", (code) => {
        console.log(`[Exec] Command completed: ${command}, Exit code: ${code}`);

        resolve({
          exitCode: code || 0,
          stderr,
          stdout,
          success: code === 0,
        });
      });

      child.on("error", (error) => {
        reject(error);
      });
    }
  });
}

export async function handleExecuteRequest(
  req: Request,
  corsHeaders: Record<string, string>,
  sessionManager?: SessionManager
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, sessionId, background, cwd, env } = body;

    if (!command || typeof command !== "string") {
      return new Response(
        JSON.stringify({
          error: "Command is required and must be a string",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    console.log(`[Exec] Executing command: ${command}`);

    // ALWAYS use session manager for isolation (implicit sessions)
    let result: Omit<ExecuteResponse, 'command' | 'timestamp'>;
    if (sessionManager) {
      try {
        // Check if we have a session-specific session
        let sessionName = 'default';
        if (sessionId) {
          // Use session-specific session for stateful operations
          sessionName = `session-${sessionId}`;
          const session = sessionManager.getSession(sessionName);
          if (!session) {
            // Create session on-demand with user's env/cwd
            await sessionManager.createSession({
              name: sessionName,
              env: env || {},
              cwd: typeof cwd === 'string' ? cwd : '/workspace',
              isolation: true
            });
          }
        }
        
        // Execute in the appropriate session
        const execResult = sessionName === 'default' 
          ? await sessionManager.exec(command)
          : await sessionManager.getSession(sessionName)!.exec(command);
          
        result = {
          ...execResult,
          success: execResult.exitCode === 0
        };
      } catch (error) {
        // Log security fallback prominently
        console.warn("[Exec] WARNING: SESSION ISOLATION FAILED - Falling back to regular execution");
        console.warn("[Exec] WARNING: This may expose control plane processes to sandboxed commands");
        console.error("[Exec] Session execution error:", error);
        
        // Fallback to regular execution - but make it clear this is a degraded state
        result = await executeCommand(command, { sessionId, background, cwd, env });
      }
    } else {
      // Session manager not available - log warning
      console.warn("[Exec] WARNING: Session manager not available - using regular execution");
      result = await executeCommand(command, { sessionId, background, cwd, env });
    }

    return new Response(
      JSON.stringify({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        success: result.success,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error) {
    console.error("[Exec] Error in handleExecuteRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to execute command",
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
}

export async function handleStreamingExecuteRequest(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, sessionId, background, cwd, env } = body;

    if (!command || typeof command !== "string") {
      return new Response(
        JSON.stringify({
          error: "Command is required and must be a string",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          status: 400,
        }
      );
    }

    console.log(
      `[Exec] Executing streaming command: ${command}`
    );

    const stream = new ReadableStream({
      start(controller) {
        const spawnOptions: SpawnOptions = {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"] as const,
          detached: background || false,
          cwd: cwd || "/workspace", // Default to clean /workspace directory
          env: env ? { ...process.env, ...env } : process.env
        };

        const child = spawn(command, spawnOptions);

        // For background processes, unref to prevent blocking
        if (background) {
          child.unref();
        }

        let stdout = "";
        let stderr = "";

        // Send command start event
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              type: "start",
              timestamp: new Date().toISOString(),
              command,
              background: background || false,
            })}\n\n`
          )
        );

        child.stdout?.on("data", (data) => {
          const output = data.toString();
          stdout += output;

          // Send real-time output
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "stdout",
                timestamp: new Date().toISOString(),
                data: output,
                command,
              })}\n\n`
            )
          );
        });

        child.stderr?.on("data", (data) => {
          const output = data.toString();
          stderr += output;

          // Send real-time error output
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "stderr",
                timestamp: new Date().toISOString(),
                data: output,
                command,
              })}\n\n`
            )
          );
        });

        child.on("close", (code) => {
          console.log(
            `[Exec] Command completed: ${command}, Exit code: ${code}`
          );

          // Send command completion event
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "complete",
                timestamp: new Date().toISOString(),
                command,
                exitCode: code,
                result: {
                  success: code === 0,
                  exitCode: code,
                  stdout,
                  stderr,
                  command,
                  timestamp: new Date().toISOString(),
                },
              })}\n\n`
            )
          );

          // For non-background processes, close the stream
          // For background processes with streaming, the stream stays open
          if (!background) {
            controller.close();
          }
        });

        child.on("error", (error) => {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "error",
                timestamp: new Date().toISOString(),
                error: error.message,
                command,
              })}\n\n`
            )
          );

          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error("[Exec] Error in handleStreamingExecuteRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to execute streaming command",
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
}
