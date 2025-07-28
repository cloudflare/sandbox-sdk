import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mapGitError, createErrorResponse, SandboxOperation } from "../utils/error-mapping";
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
      const errorData = {
        error: "Repository URL is required and must be a string",
        code: 'INVALID_GIT_URL',
        operation: SandboxOperation.GIT_CHECKOUT,
        httpStatus: 400,
        details: 'Repository URL parameter is missing or not a valid string'
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Validate repository URL format
    const urlPattern =
      /^(https?:\/\/|git@|ssh:\/\/).*\.git$|^https?:\/\/.*\/.*$/;
    if (!urlPattern.test(repoUrl)) {
      const errorData = {
        error: `Invalid repository URL format: ${repoUrl}`,
        code: 'INVALID_GIT_URL',
        operation: SandboxOperation.GIT_CHECKOUT,
        httpStatus: 400,
        details: `Repository URL "${repoUrl}" does not match expected format`
      };
      return createErrorResponse(errorData, corsHeaders);
    }

    // Generate target directory if not provided using cryptographically secure randomness
    const checkoutDir =
      targetDir ||
      `repo_${Date.now()}_${randomBytes(6).toString('hex')}`;

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

    // Check if git operation failed
    if (!result.success) {
      const gitError = { message: result.stderr, stderr: result.stderr };
      const errorData = mapGitError(gitError, SandboxOperation.GIT_CHECKOUT, repoUrl, branch);
      return createErrorResponse(errorData, corsHeaders);
    }

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
    let repoUrl = 'unknown';
    let branch = 'unknown';
    try {
      const body = await req.clone().json() as GitCheckoutRequest;
      repoUrl = body?.repoUrl || 'unknown';
      branch = body?.branch || 'unknown';
    } catch {}
    const errorData = mapGitError(error, SandboxOperation.GIT_CHECKOUT, repoUrl, branch);
    return createErrorResponse(errorData, corsHeaders);
  }
}

