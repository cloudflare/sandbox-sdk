import type { Sandbox } from "@cloudflare/sandbox";
import { corsHeaders, errorResponse, parseJsonBody } from "../http";

export async function executeCommandStream(sandbox: Sandbox<unknown>, request: Request) {
    const body = await parseJsonBody(request);
    const { command, sessionId } = body;

    if (!command) {
        return errorResponse("Command is required");
    }

    // Create readable stream for SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Start streaming in the background
    (async () => {
        try {
            const encoder = new TextEncoder();

            // Send start event
            await writer.write(encoder.encode(`data: ${JSON.stringify({
                type: 'start',
                timestamp: new Date().toISOString(),
                command: command
            })}\n\n`));

            // Check if execStream method exists, otherwise fallback to regular exec
            if (typeof sandbox.execStream === 'function') {
                const readableStream = await sandbox.execStream(command, { sessionId });
                const reader = readableStream.getReader();

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        // Forward the raw SSE data directly
                        await writer.write(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                // Fallback to regular execution if streaming not available
                try {
                    const result = await sandbox.exec(command, { sessionId });
                    await writer.write(encoder.encode(`data: ${JSON.stringify({
                        type: 'complete',
                        timestamp: new Date().toISOString(),
                        exitCode: result.exitCode,
                        result
                    })}\n\n`));
                } catch (error: any) {
                    await writer.write(encoder.encode(`data: ${JSON.stringify({
                        type: 'error',
                        timestamp: new Date().toISOString(),
                        error: error.message
                    })}\n\n`));
                }
            }
        } catch (error: any) {
            const errorEvent = {
                type: 'error',
                timestamp: new Date().toISOString(),
                error: error.message
            };
            await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } finally {
            await writer.close();
        }
    })();

    return new Response(readable, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...corsHeaders(),
        },
    });
}
