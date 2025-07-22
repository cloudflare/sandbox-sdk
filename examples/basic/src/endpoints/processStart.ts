import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse, parseJsonBody } from "../http";

export async function startProcess(sandbox: Sandbox<unknown>, request: Request) {
    const body = await parseJsonBody(request);
    const { command, processId, sessionId, timeout, env: envVars, cwd } = body;

    if (!command) {
        return errorResponse("Command is required");
    }

    if (typeof sandbox.startProcess === 'function') {
        const process = await sandbox.startProcess(command, {
            processId,
            sessionId,
            timeout,
            env: envVars,
            cwd
        });
        return jsonResponse(process);
    } else {
        return errorResponse("Process management not implemented in current SDK version", 501);
    }
}