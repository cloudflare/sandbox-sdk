import { vi } from "vite-plus/test";

export class TestExecutionContext<Props> implements ExecutionContext<Props> {
  constructor(readonly props: Props) {}

  get exports(): Cloudflare.Exports {
    throw new Error("TestExecutionContext.exports is not implemented");
  }

  waitUntil(): void {}

  passThroughOnException(): void {}

  async restore(): Promise<never> {
    throw new Error("TestExecutionContext.restore is not implemented");
  }

  mapVirtualHost(): string {
    throw new Error("TestExecutionContext.mapVirtualHost is not implemented");
  }

  get tracing(): Tracing {
    throw new Error("TestExecutionContext.tracing is not implemented");
  }

  abort(): void {}
}

export class TestFetcher implements Fetcher {
  readonly fetchCalls = vi.fn();

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.fetchCalls(input, init);
    return new Response(null);
  }

  connect(_address: SocketAddress | string, _options?: SocketOptions): Socket {
    throw new Error("TestFetcher.connect is not implemented");
  }

  async queue(
    _queueName: string,
    _messages: ServiceBindingQueueMessage[],
    _metadata?: MessageBatchMetadata,
  ): Promise<FetcherQueueResult> {
    throw new Error("TestFetcher.queue is not implemented");
  }

  async scheduled(_options?: FetcherScheduledOptions): Promise<FetcherScheduledResult> {
    throw new Error("TestFetcher.scheduled is not implemented");
  }
}
