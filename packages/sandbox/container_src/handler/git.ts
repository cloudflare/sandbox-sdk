import { randomBytes } from "node:crypto";
import type { GitCheckoutRequest } from "../types";
import type { SessionManager } from "../utils/isolation";

async function executeGitCheckout(
  sessionManager: SessionManager,
  sessionName: string | undefined,
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
  const session = sessionName 
    ? sessionManager.getSession(sessionName) 
    : sessionManager.getSession('default');
    
  if (!session) {
    // Create default session if it doesn't exist
    if (!sessionName || sessionName === 'default') {
      await sessionManager.createSession({
        name: 'default',
        cwd: '/workspace',
        isolation: true
      });
      const defaultSession = sessionManager.getSession('default');
      if (!defaultSession) {
        throw new Error('Failed to create default session');
      }
      return defaultSession.exec(command);
    }
    throw new Error(`Session '${sessionName}' not found`);
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
    const { repoUrl, branch = "main", targetDir, sessionName } = body;

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
      `[Server] Checking out repository: ${repoUrl} to ${checkoutDir}${sessionName ? ` in session: ${sessionName}` : ''}`
    );

    const result = await executeGitCheckout(
      sessionManager,
      sessionName,
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

