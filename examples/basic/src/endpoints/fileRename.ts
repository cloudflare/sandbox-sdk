import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function renameFile(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { oldPath, newPath } = body;

    if (!oldPath || !newPath) {
      return errorResponse("oldPath and newPath are required");
    }

    await sandbox.renameFile(oldPath, newPath);
    return jsonResponse({
      success: true,
      message: "File renamed",
      oldPath,
      newPath,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error renaming file:", error);
    return errorResponse(`Failed to rename file: ${error.message}`);
  }
}
