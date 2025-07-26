import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function createDirectory(
  sandbox: Sandbox<unknown>,
  request: Request
) {
  try {
    const body = await parseJsonBody(request);
    const { path, recursive } = body;

    if (!path) {
      return errorResponse("Path is required");
    }

    await sandbox.mkdir(path, { recursive });
    return jsonResponse({
      success: true,
      message: "Directory created",
      path,
      recursive: recursive || false,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error creating directory:", error);
    return errorResponse(`Failed to create directory: ${error.message}`);
  }
}
