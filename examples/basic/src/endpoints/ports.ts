import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function exposePort(sandbox: Sandbox<unknown>, request: Request) {
    const body = await parseJsonBody(request);
    const { port, name } = body;

    if (!port) {
        return errorResponse("Port number is required");
    }

    const preview = await sandbox.exposePort(port, name ? { name } : undefined);
    return jsonResponse(preview);
}

export async function unexposePort(sandbox: Sandbox<unknown>, request: Request) {
    const body = await parseJsonBody(request);
    const { port } = body;

    if (!port) {
        return errorResponse("Port number is required");
    }

    await sandbox.unexposePort(port);
    return jsonResponse({ message: "Port unexposed", port });
}

