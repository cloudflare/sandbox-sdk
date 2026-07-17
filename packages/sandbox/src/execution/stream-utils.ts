export function stringToReadableStream(
  input: string
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

export async function readAllBytes(
  stream: ReadableStream<Uint8Array> | null
): Promise<ArrayBuffer> {
  if (!stream) return new ArrayBuffer(0);

  const response = new Response(stream);
  return response.arrayBuffer();
}
