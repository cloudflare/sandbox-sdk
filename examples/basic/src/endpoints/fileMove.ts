import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function moveFile(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { sourcePath, destinationPath } = body;

    if (!sourcePath || !destinationPath) {
      return errorResponse("sourcePath and destinationPath are required");
    }

    await sandbox.moveFile(sourcePath, destinationPath);
    return jsonResponse({ 
      success: true,
      message: "File moved",
      sourcePath,
      destinationPath,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("Error moving file:", error);
    return errorResponse(`Failed to move file: ${error.message}`);
  }
}