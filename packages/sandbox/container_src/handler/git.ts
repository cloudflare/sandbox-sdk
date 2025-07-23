import { spawn } from "node:child_process";
import type { GitCheckoutRequest, SessionData } from "../types";

function executeGitCheckout(
  sessions: Map<string, SessionData>,
  repoUrl: string,
  branch: string,
  targetDir: string,
  sessionId?: string
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    // First, clone the repository
    const cloneChild = spawn(
      "git",
      ["clone", "-b", branch, repoUrl, targetDir],
      {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Store the process reference for cleanup if sessionId is provided
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.activeProcess = cloneChild;
    }

    let stdout = "";
    let stderr = "";

    cloneChild.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    cloneChild.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    cloneChild.on("close", (code) => {
      // Clear the active process reference
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.activeProcess = null;
      }

      if (code === 0) {
        console.log(
          `[Server] Repository cloned successfully: ${repoUrl} to ${targetDir}`
        );
        resolve({
          exitCode: code || 0,
          stderr,
          stdout,
          success: true,
        });
      } else {
        console.error(
          `[Server] Failed to clone repository: ${repoUrl}, Exit code: ${code}`
        );
        resolve({
          exitCode: code || 1,
          stderr,
          stdout,
          success: false,
        });
      }
    });

    cloneChild.on("error", (error) => {
      // Clear the active process reference
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.activeProcess = null;
      }

      console.error(`[Server] Error cloning repository: ${repoUrl}`, error);
      reject(error);
    });
  });
}

export async function handleGitCheckoutRequest(
  sessions: Map<string, SessionData>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as GitCheckoutRequest;
    const { repoUrl, branch = "main", targetDir, sessionId } = body;

    if (!repoUrl || typeof repoUrl !== "string") {
      return new Response(
        JSON.stringify({
          error: "Repository URL is required and must be a string",
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

    // Validate repository URL format
    const urlPattern =
      /^(https?:\/\/|git@|ssh:\/\/).*\.git$|^https?:\/\/.*\/.*$/;
    if (!urlPattern.test(repoUrl)) {
      return new Response(
        JSON.stringify({
          error: "Invalid repository URL format",
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

    // Generate target directory if not provided
    const checkoutDir =
      targetDir ||
      `repo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(
      `[Server] Checking out repository: ${repoUrl} to ${checkoutDir}`
    );

    const result = await executeGitCheckout(
      sessions,
      repoUrl,
      branch,
      checkoutDir,
      sessionId
    );

    return new Response(
      JSON.stringify({
        branch,
        exitCode: result.exitCode,
        repoUrl,
        stderr: result.stderr,
        stdout: result.stdout,
        success: result.success,
        targetDir: checkoutDir,
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
    console.error("[Server] Error in handleGitCheckoutRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to checkout repository",
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

export async function handleStreamingGitCheckoutRequest(
  sessions: Map<string, SessionData>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as GitCheckoutRequest;
    const { repoUrl, branch = "main", targetDir, sessionId } = body;

    if (!repoUrl || typeof repoUrl !== "string") {
      return new Response(
        JSON.stringify({
          error: "Repository URL is required and must be a string",
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

    // Validate repository URL format
    const urlPattern =
      /^(https?:\/\/|git@|ssh:\/\/).*\.git$|^https?:\/\/.*\/.*$/;
    if (!urlPattern.test(repoUrl)) {
      return new Response(
        JSON.stringify({
          error: "Invalid repository URL format",
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

    // Generate target directory if not provided
    const checkoutDir =
      targetDir ||
      `repo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(
      `[Server] Checking out repository: ${repoUrl} to ${checkoutDir}`
    );

    const stream = new ReadableStream({
      start(controller) {
        const child = spawn(
          "git",
          ["clone", "-b", branch, repoUrl, checkoutDir],
          {
            shell: true,
            stdio: ["pipe", "pipe", "pipe"],
          }
        );

        // Store the process reference for cleanup if sessionId is provided
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          session.activeProcess = child;
        }

        let stdout = "";
        let stderr = "";

        // Send command start event
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              command: `git clone ${branch} ${repoUrl} ${checkoutDir}`,
              timestamp: new Date().toISOString(),
              type: "command_start",
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
                command: "git clone",
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
                command: "git clone",
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
            `[Server] Command completed: git clone, Exit code: ${code}`
          );

          // Send command completion event
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                command: `git clone ${branch} ${repoUrl} ${checkoutDir}`,
                exitCode: code,
                stderr,
                stdout,
                success: code === 0,
                timestamp: new Date().toISOString(),
                type: "command_complete",
              })}\n\n`
            )
          );

          controller.close();
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
                command: `git clone ${branch} ${repoUrl} ${checkoutDir}`,
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
    console.error(
      "[Server] Error in handleStreamingGitCheckoutRequest:",
      error
    );
    return new Response(
      JSON.stringify({
        error: "Failed to checkout repository",
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
