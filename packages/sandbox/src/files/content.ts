export type FileContent =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream<Uint8Array>;

export function fileContentStream(content: FileContent): ReadableStream<Uint8Array> {
  if (content instanceof ReadableStream) return content;
  if (content instanceof Blob) return content.stream();

  let bytes: Uint8Array;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public union boundary selects encoding.
  if (typeof content === "string") {
    bytes = new TextEncoder().encode(content);
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else {
    bytes = new Uint8Array(content.byteLength);
    bytes.set(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
