import { Sandbox } from "@cloudflare/sandbox";
import { corsHeaders, errorResponse, jsonResponse } from "../http";

export async function getProcessLogs(sandbox: Sandbox<unknown>, pathname: string) {
    const pathParts = pathname.split("/");
    const processId = pathParts[pathParts.length - 2];

    if (!processId) {
        return errorResponse("Process ID is required");
    }

    if (typeof sandbox.getProcessLogs === 'function') {
        const logs = await sandbox.getProcessLogs(processId);
        return jsonResponse(logs);
    } else {
        return errorResponse("Process management not implemented in current SDK version", 501);
    }
}

export async function streamProcessLogs(sandbox: Sandbox<unknown>, pathname: string) {
    const pathParts = pathname.split("/");
    const processId = pathParts[pathParts.length - 2];

    if (!processId) {
        return errorResponse("Process ID is required");
    }

    // Check if process exists first
    if (typeof sandbox.getProcess === 'function') {
        try {
            const process = await sandbox.getProcess(processId);
            if (!process) {
                return errorResponse("Process not found", 404);
            }
        } catch (error: any) {
            return errorResponse(`Failed to check process: ${error.message}`, 500);
        }
    }

    // Use the SDK's streaming and forward directly
    if (typeof sandbox.streamProcessLogs === 'function') {
        try {
            // Get the ReadableStream directly from the SDK
            const readableStream = await sandbox.streamProcessLogs(processId);

            // Return stream with proper headers
            return new Response(readableStream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    ...corsHeaders(),
                },
            });
        } catch (error: any) {
            console.error('Process log streaming error:', error);
            return errorResponse(`Failed to stream process logs: ${error.message}`, 500);
        }
    } else {
        return errorResponse("Process streaming not implemented in current SDK version", 501);
    }
}
