import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function readFile(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { path, encoding } = body;

    if (!path) {
      return errorResponse("Path is required");
    }

    const result = await sandbox.readFile(path, { encoding });
    return jsonResponse({ 
      success: true,
      path, 
      content: result.content, // Extract the actual content string from the response
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("Error reading file:", error);
    return errorResponse(`Failed to read file: ${error.message}`);
  }
}