import { SessionManager } from "../isolation";
import { CreateSessionRequest } from "../types";

export async function handleCreateSession(
  req: Request,
  corsHeaders: Record<string, string>,
  sessionManager: SessionManager 
) {
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

    await sessionManager.createSession({
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

export function handleListSessions(
  corsHeaders: Record<string, string>,
  sessionManager: SessionManager
) {
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
