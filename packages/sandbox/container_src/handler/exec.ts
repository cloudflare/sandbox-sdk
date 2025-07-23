import { spawn, type SpawnOptions } from "node:child_process";
import type { ExecuteRequest, SessionData } from "../types";

function executeCommand(
  sessions: Map<string, SessionData>,
  command: string,
  sessionId?: string,
  background?: boolean
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"] as const,
      detached: background || false,
    };

    const child = spawn(command, spawnOptions);

    // Store the process reference for cleanup if sessionId is provided
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.activeProcess = child;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    if (background) {
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
        console.error(`[Server] Background process error: ${command}`, error);
        // Don't reject since we might have already resolved
      });
    } else {
      // Normal synchronous execution
      child.on("close", (code) => {
        // Clear the active process reference
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.activeProcess = null;
        }

        console.log(`[Server] Command completed: ${command}, Exit code: ${code}`);

        resolve({
          exitCode: code || 0,
          stderr,
          stdout,
          success: code === 0,
        });
      });

      child.on("error", (error) => {
        // Clear the active process reference
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.activeProcess = null;
        }

        reject(error);
      });
    }
  });
}

export async function handleExecuteRequest(
  sessions: Map<string, SessionData>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, sessionId, background } = body;

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

    console.log(`[Server] Executing command: ${command}`);

    const result = await executeCommand(sessions, command, sessionId, background);

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
    console.error("[Server] Error in handleExecuteRequest:", error);
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
  sessions: Map<string, SessionData>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, sessionId, background } = body;

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
      `[Server] Executing streaming command: ${command}`
    );

    const stream = new ReadableStream({
      start(controller) {
        const spawnOptions: SpawnOptions = {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"] as const,
          detached: background || false,
        };

        const child = spawn(command, spawnOptions);

        // Store the process reference for cleanup if sessionId is provided
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.activeProcess = child;
        }

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
              command,
              timestamp: new Date().toISOString(),
              type: "command_start",
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
                command,
                data: output,
                stream: "stdout",
                type: "output",
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
                command,
                data: output,
                stream: "stderr",
                type: "output",
              })}\n\n`
            )
          );
        });

        child.on("close", (code) => {
          // Clear the active process reference
          if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId)!;
            session.activeProcess = null;
          }

          console.log(
            `[Server] Command completed: ${command}, Exit code: ${code}`
          );

          // Send command completion event
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                command,
                exitCode: code,
                stderr,
                stdout,
                success: code === 0,
                timestamp: new Date().toISOString(),
                type: "command_complete",
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
          // Clear the active process reference
          if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId)!;
            session.activeProcess = null;
          }

          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                command,
                error: error.message,
                type: "error",
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
    console.error("[Server] Error in handleStreamingExecuteRequest:", error);
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
