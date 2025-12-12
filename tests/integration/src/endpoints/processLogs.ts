import {
  type LogEvent,
  parseSSEStream,
  type Sandbox
} from '@cloudflare/sandbox';
import { corsHeaders, errorResponse, jsonResponse } from '../http';

export async function getProcessLogs(
  sandbox: Sandbox<unknown>,
  pathname: string
) {
  const pathParts = pathname.split('/');
  const processId = pathParts[pathParts.length - 2];

  if (!processId) {
    return errorResponse('Process ID is required');
  }

  if (typeof sandbox.getProcessLogs === 'function') {
    const logs = await sandbox.getProcessLogs(processId);
    return jsonResponse(logs);
  } else {
    return errorResponse(
      'Process management not implemented in current SDK version',
      501
    );
  }
}

export async function streamProcessLogs(
  sandbox: Sandbox<unknown>,
  pathname: string,
  request: Request
) {
  const pathParts = pathname.split('/');
  const processId = pathParts[pathParts.length - 2];

  if (!processId) {
    return errorResponse('Process ID is required');
  }

  // Check if process exists first
  if (typeof sandbox.getProcess === 'function') {
    try {
      const process = await sandbox.getProcess(processId);
      if (!process) {
        return errorResponse('Process not found', 404);
      }
    } catch (error: any) {
      return errorResponse(`Failed to check process: ${error.message}`, 500);
    }
  }

  // Use the SDK's streaming with beautiful AsyncIterable API
  if (typeof sandbox.streamProcessLogs === 'function') {
    try {
      // Create an AbortController that will be triggered when client disconnects
      const abortController = new AbortController();

      // Create SSE stream from AsyncIterable
      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Stream logs in the background
      (async () => {
        try {
          // Get the ReadableStream from sandbox (can't pass abort signal through Worker binding)
          const stream = await sandbox.streamProcessLogs(processId);

          // Convert to AsyncIterable using parseSSEStream with local abort signal
          for await (const logEvent of parseSSEStream<LogEvent>(
            stream,
            abortController.signal
          )) {
            // Forward each typed event as SSE
            await writer.write(
              encoder.encode(`data: ${JSON.stringify(logEvent)}\n\n`)
            );
          }
        } catch (error: any) {
          // Don't send error event for abort
          if (error.name === 'AbortError') {
            console.log('Stream aborted by client');
          } else {
            // Send error event
            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'error',
                  timestamp: new Date().toISOString(),
                  data: error.message,
                  processId
                })}\n\n`
              )
            );
          }
        } finally {
          await writer.close();
        }
      })();

      // Handle client disconnect by aborting
      request.signal.addEventListener('abort', () => {
        abortController.abort();
      });

      // Return stream with proper headers
      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...corsHeaders()
        }
      });
    } catch (error: any) {
      console.error('Process log streaming error:', error);
      return errorResponse(
        `Failed to stream process logs: ${error.message}`,
        500
      );
    }
  } else {
    return errorResponse(
      'Process streaming not implemented in current SDK version',
      501
    );
  }
}
