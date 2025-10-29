import type { Sandbox } from "@cloudflare/sandbox";
import { streamFile } from "@cloudflare/sandbox";
import { corsHeaders, errorResponse, parseJsonBody } from "../http";

interface FileStreamEvent {
  type: "metadata" | "chunk" | "complete" | "error";
  mimeType?: string;
  size?: number;
  isBinary?: boolean;
  encoding?: string;
  data?: string;
  error?: string;
}

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function readFileStream(sandbox: Sandbox<unknown>, request: Request) {
  try {
    const body = await parseJsonBody(request);
    const { path } = body;

    if (!path) {
      return errorResponse("Path is required");
    }

    // Create readable stream for SSE
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Start streaming in the background
    (async () => {
      try {
        const encoder = new TextEncoder();

        // Get the ReadableStream from sandbox
        const stream = await sandbox.readFileStream(path);

        // Use streamFile to iterate over chunks with auto base64 decoding
        const fileIterator = streamFile(stream);

        // Track if we've sent metadata
        let metadataSent = false;
        let totalBytesRead = 0;

        for await (const chunk of fileIterator) {
          // Send metadata on first chunk
          if (!metadataSent && (streamFile as any).metadata) {
            const metadata = (streamFile as any).metadata;
            const metadataEvent: FileStreamEvent = {
              type: "metadata",
              mimeType: metadata.mimeType,
              size: metadata.size,
              isBinary: metadata.isBinary,
              encoding: metadata.encoding,
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(metadataEvent)}\n\n`));
            metadataSent = true;
          }

          // Send chunk data
          const chunkEvent: FileStreamEvent = {
            type: "chunk",
            data: chunk instanceof Uint8Array
              ? uint8ArrayToBase64(chunk)  // Binary: convert back to base64 for transmission
              : chunk,                      // Text: send as-is
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunkEvent)}\n\n`));

          // Track bytes
          totalBytesRead += chunk instanceof Uint8Array ? chunk.byteLength : chunk.length;
        }

        // Send complete event
        const completeEvent: FileStreamEvent = {
          type: "complete",
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`));
      } catch (error: any) {
        const errorEvent: FileStreamEvent = {
          type: "error",
          error: error.message,
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
  } catch (error: any) {
    console.error("Error streaming file:", error);
    return errorResponse(`Failed to stream file: ${error.message}`);
  }
}
