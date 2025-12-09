import type { ErrorResponse } from '@repo/shared/errors';
import { SandboxError } from '../errors';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  sandboxId: string;
  timeout?: number;
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      ...this.options.headers
    };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.options.baseUrl}/api/sandbox/${this.options.sandboxId}${path}`;

    const response = await fetch(url, {
      method,
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new SandboxError({
        code: errorBody.error || 'REQUEST_FAILED',
        message:
          errorBody.message || `Request failed with status ${response.status}`,
        httpStatus: response.status,
        timestamp: new Date().toISOString()
      } as ErrorResponse);
    }

    return response.json() as Promise<T>;
  }

  async requestStream(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.options.baseUrl}/api/sandbox/${this.options.sandboxId}${path}`;

    const response = await fetch(url, {
      method,
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new SandboxError({
        code: errorBody.error || 'REQUEST_FAILED',
        message:
          errorBody.message || `Request failed with status ${response.status}`,
        httpStatus: response.status,
        timestamp: new Date().toISOString()
      } as ErrorResponse);
    }

    if (!response.body) {
      throw new Error('Response has no body');
    }

    return response.body;
  }
}
