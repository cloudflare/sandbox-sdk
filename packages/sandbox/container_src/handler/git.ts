import { randomBytes } from "node:crypto";
import type { GitCheckoutRequest } from "../types";
import type { Session, SessionManager } from "../utils/isolation";

async function executeGitCheckout(
  sessionManager: SessionManager,
  sessionId: string | undefined,
  repoUrl: string,
  branch: string,
  targetDir: string
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  // Execute git clone through the session to respect working directory
  const command = `git clone -b ${branch} ${repoUrl} ${targetDir}`;
  
  // Use specific session if provided, otherwise use default session
  let session: Session | undefined;
  
  if (sessionId) {
    session = sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
  } else {
    // Use the centralized method to get or create default session
    session = await sessionManager.getOrCreateDefaultSession();
  }
  
  return session.exec(command);
}

export async function handleGitCheckoutRequest(
  req: Request,
  corsHeaders: Record<string, string>,
  sessionManager: SessionManager
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

    // Generate target directory if not provided using cryptographically secure randomness
    const checkoutDir =
      targetDir ||
      `repo_${Date.now()}_${randomBytes(6).toString('hex')}`;

    console.log(
      `[Server] Checking out repository: ${repoUrl} to ${checkoutDir}${sessionId ? ` in session: ${sessionId}` : ''}`
    );

    const result = await executeGitCheckout(
      sessionManager,
      sessionId,
      repoUrl,
      branch,
      checkoutDir
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

