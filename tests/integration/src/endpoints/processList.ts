import type { Sandbox } from "@cloudflare/sandbox";
import { errorResponse, jsonResponse } from "../http";

export const listProcesses = async (sandbox: Sandbox<unknown>) => {
    if (typeof sandbox.listProcesses === 'function') {
        const processes = await sandbox.listProcesses();
        return jsonResponse({ processes });
    } else {
        return errorResponse("Process management not implemented in current SDK version", 501);
    }
}
