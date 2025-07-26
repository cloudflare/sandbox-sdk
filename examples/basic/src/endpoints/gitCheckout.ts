import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function gitCheckout(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { repoUrl, branch, targetDir } = body;

    if (!repoUrl) {
      return errorResponse("repoUrl is required");
    }

    const actualBranch = branch || "main";
    await sandbox.gitCheckout(repoUrl, { branch: actualBranch, targetDir });

    return jsonResponse({
      success: true,
      message: "Repository checked out",
      repoUrl,
      branch: actualBranch,
      targetDir,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error checking out repository:", error);
    return errorResponse(`Failed to checkout repository: ${error.message}`);
  }
}
