import { type SpawnOptions, spawn } from "node:child_process";
import type { ExecuteResponse } from "../../src/types";
import type { ExecuteOptions, ExecuteRequest } from "../types";
import type { SessionManager } from "../utils/isolation";


export async function handleExecuteRequest(
  req: Request,
  corsHeaders: Record<string, string>,
  sessionManager?: SessionManager
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, background, cwd, env } = body;

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

    if (!sessionManager) {
      throw new Error("Session manager is required for secure execution");
    }

    // Use session manager for global execution
    const execResult = await sessionManager.exec(command, { cwd });
      
    const result = {
      ...execResult,
      success: execResult.exitCode === 0
    };

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
        message: error instanceof Error ? error.message : "Unknown error"
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
  corsHeaders: Record<string, string>,
  sessionManager?: SessionManager
): Promise<Response> {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const { command, background, cwd, env } = body;

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

    if (!sessionManager) {
      throw new Error("Session manager is required for secure streaming execution");
    }

    console.log(`[Exec] Executing streaming command: ${command}`);

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Use global session for streaming execution
          const execGenerator = sessionManager.execStream(command, { cwd });
            
          // Stream events as they come
          for await (const event of execGenerator) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(event)}\n\n`
              )
            );
            
            // Close stream on completion or error
            if (event.type === 'complete' || event.type === 'error') {
              controller.close();
              break;
            }
          }
        } catch (error) {
          console.error("[Exec] Streaming execution error:", error);
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "error",
                timestamp: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
                command,
              })}\n\n`
            )
          );
          controller.close();
        }
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
        message: error instanceof Error ? error.message : "Unknown error"
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
