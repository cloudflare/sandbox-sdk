export interface DrainCancellation {
  readonly aborted: boolean;
  subscribe(listener: () => void): () => void;
}

export class DrainCancellationSource implements DrainCancellation {
  readonly #listeners = new Set<() => void>();
  #aborted = false;

  get aborted(): boolean {
    return this.#aborted;
  }

  subscribe(listener: () => void): () => void {
    if (this.#aborted) {
      listener();
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }
}

export async function drainReadableStream(
  stream: ReadableStream<Uint8Array>,
  append: (data: Uint8Array) => void,
  cancellation: DrainCancellation
): Promise<void> {
  const reader = stream.getReader();
  const unsubscribe = cancellation.subscribe(() => {
    void reader.cancel().catch(() => undefined);
  });
  try {
    if (cancellation.aborted) return;
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      append(result.value);
    }
  } finally {
    unsubscribe();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
