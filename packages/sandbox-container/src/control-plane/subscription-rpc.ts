import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { RpcTarget } from 'capnweb';

export class StreamSubscriptionRPC<T> extends RpcTarget {
  readonly #reader: ReadableStreamDefaultReader<T>;
  #cancelPromise?: Promise<void>;
  #streamOpened = false;
  #sourceDone = false;
  #readerReleased = false;
  #controller?: ReadableStreamDefaultController<T>;

  constructor(source: ReadableStream<T>) {
    super();
    this.#reader = source.getReader();
  }

  async stream(): Promise<ReadableStream<T>> {
    if (this.#streamOpened) {
      throw new Error('Subscription stream already opened');
    }
    this.#streamOpened = true;

    return new ReadableStream<T>({
      start: (controller) => {
        this.#controller = controller;
        if (this.#cancelPromise !== undefined) controller.close();
      },
      pull: async (controller) => {
        if (this.#cancelPromise !== undefined) {
          controller.close();
          return;
        }
        try {
          const result = await this.#reader.read();
          if (result.done) {
            this.#sourceDone = true;
            this.#releaseReader();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          this.#sourceDone = true;
          this.#releaseReader();
          throw error;
        }
      },
      cancel: () => this.cancel()
    });
  }

  async cancel(): Promise<void> {
    if (this.#sourceDone) {
      this.#closeOutput();
      return;
    }
    if (this.#cancelPromise === undefined) {
      this.#cancelPromise = this.#reader
        .cancel()
        .catch(() => undefined)
        .then(() => {
          this.#releaseReader();
          this.#closeOutput();
        });
    }
    return this.#cancelPromise;
  }

  [Symbol.dispose](): void {
    void this.cancel();
  }

  #releaseReader(): void {
    if (this.#readerReleased) return;
    this.#readerReleased = true;
    this.#reader.releaseLock();
  }

  #closeOutput(): void {
    try {
      this.#controller?.close();
    } catch {
      // The consumer may have cancelled or closed the returned stream first.
    }
  }
}
