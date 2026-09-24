export type BoundedBody =
  | { readonly status: "absent" }
  | { readonly status: "exceeded" }
  | { readonly status: "complete"; readonly bytes: Uint8Array };

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  cancelReason: string,
): Promise<BoundedBody> {
  if (body === null) return { status: "absent" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) {
        await reader.cancel(cancelReason);
        return { status: "exceeded" };
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "complete", bytes };
}
