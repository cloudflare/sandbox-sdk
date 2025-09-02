import type { SessionManager } from "../isolation";
import type { SessionExecRequest } from "../types";

export async function handleExecuteRequest(
  req: Request,
  corsHeaders: Record<string, string>,
  sessionManager: SessionManager
) {
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

export async function handleStreamingExecuteRequest(
  req: Request,
  sessionManager: SessionManager,
  corsHeaders: Record<string, string>
) {
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
