import type { Sandbox } from '@cloudflare/sandbox';
import { parseSSEStream, type ExecEvent } from '@cloudflare/sandbox';
import { corsHeaders, errorResponse, parseJsonBody } from '../http';

export async function executeCommandStream(
  sandbox: Sandbox<unknown>,
  request: Request
) {
  const body = await parseJsonBody(request);
  const { command } = body;

  if (!command) {
    return errorResponse('Command is required');
  }

  // Create readable stream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Start streaming in the background
  (async () => {
    try {
      const encoder = new TextEncoder();

      // Get the ReadableStream from sandbox
      const stream = await sandbox.execStream(command);

      // Convert to AsyncIterable using parseSSEStream
      for await (const event of parseSSEStream<ExecEvent>(stream)) {
        // Forward each typed event as SSE
        await writer.write(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
    } catch (error: any) {
      const errorEvent = {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: error.message
      };
      await writer.write(
        new TextEncoder().encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
      );
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders()
    }
  });
}
