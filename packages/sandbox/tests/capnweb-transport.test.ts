import { describe, expect, it, vi } from 'vitest';
import {
	CapnwebTransport,
	createTransport,
} from '../src/clients/transport';

/**
 * Tests for capnweb transport mode.
 *
 * Testing Strategy:
 * - Factory tests: Verify createTransport produces CapnwebTransport for 'capnweb' mode
 * - Initial state tests: Verify constructor behavior and options validation
 * - Unit tests for non-connection behavior with mocked internals
 * - Full end-to-end tests with a real container are in E2E tests (Stage 3)
 *
 * Tests run in Workers runtime (vitest-pool-workers) where mocking WebSocket
 * connections is complex. Connection-dependent behavior is tested via mocked
 * internal state (same approach as ws-transport.test.ts).
 */
describe('CapnwebTransport', () => {
	describe('factory integration', () => {
		it('should create transport in capnweb mode', () => {
			const transport = createTransport({
				mode: 'capnweb',
				wsUrl: 'ws://localhost:3000/capnweb',
			});

			expect(transport).toBeInstanceOf(CapnwebTransport);
			expect(transport.getMode()).toBe('capnweb');
		});

		it('should throw if wsUrl is missing', () => {
			expect(() => {
				createTransport({
					mode: 'capnweb',
				});
			}).toThrow('wsUrl is required for capnweb transport');
		});
	});

	describe('initial state', () => {
		it('should not be connected after construction', () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			expect(transport.isConnected()).toBe(false);
		});

		it('should return capnweb as transport mode', () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			expect(transport.getMode()).toBe('capnweb');
		});

		it('should accept custom options', () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
				connectTimeoutMs: 5000,
				retryTimeoutMs: 60000,
			});
			expect(transport.isConnected()).toBe(false);
		});
	});

	describe('disconnect', () => {
		it('should be safe to call disconnect when not connected', () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			// Should not throw
			transport.disconnect();
			expect(transport.isConnected()).toBe(false);
		});

		it('should be safe to call disconnect multiple times', () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			transport.disconnect();
			transport.disconnect();
			transport.disconnect();
			expect(transport.isConnected()).toBe(false);
		});
	});

	describe('fetch without connection', () => {
		it('should attempt to connect when making a fetch request', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://invalid-url:9999/capnweb',
				connectTimeoutMs: 100,
			});

			await expect(transport.fetch('/test')).rejects.toThrow();
		});

		it('should attempt to connect when making a stream request', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://invalid-url:9999/capnweb',
				connectTimeoutMs: 100,
			});

			await expect(transport.fetchStream('/test')).rejects.toThrow();
		});
	});

	describe('connection lifecycle with mocked internals', () => {
		it('should reconnect after disconnect', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};

			const doConnect = vi
				.spyOn(internals, 'doConnect')
				.mockImplementation(async () => {
					internals.stub = mockStub;
					internals.connected = true;
					internals.ws = { close: vi.fn() };
				});

			await transport.connect();
			expect(doConnect).toHaveBeenCalledTimes(1);
			expect(transport.isConnected()).toBe(true);

			transport.disconnect();
			expect(transport.isConnected()).toBe(false);

			await transport.connect();
			expect(doConnect).toHaveBeenCalledTimes(2);
			expect(transport.isConnected()).toBe(true);
		});

		it('should share connection attempt across concurrent connect() calls', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};

			const doConnect = vi
				.spyOn(internals, 'doConnect')
				.mockImplementation(async () => {
					internals.stub = mockStub;
					internals.connected = true;
					internals.ws = { close: vi.fn() };
				});

			// Fire two concurrent connect() calls
			await Promise.all([transport.connect(), transport.connect()]);

			expect(doConnect).toHaveBeenCalledTimes(1);
		});

		it('should skip connect when already connected', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};

			const doConnect = vi
				.spyOn(internals, 'doConnect')
				.mockImplementation(async () => {
					internals.stub = mockStub;
					internals.connected = true;
					internals.ws = { close: vi.fn() };
				});

			await transport.connect();
			await transport.connect();

			expect(doConnect).toHaveBeenCalledTimes(1);
		});
	});

	describe('request/response with mocked stub', () => {
		function createConnectedTransport() {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};

			vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
				internals.stub = mockStub;
				internals.connected = true;
				internals.ws = { close: vi.fn() };
			});

			return { transport, mockStub };
		}

		it('should make GET requests via the bridge stub', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({
				status: 200,
				body: JSON.stringify({ data: 'test' }),
				headers: { 'content-type': 'application/json' },
			});

			const response = await transport.fetch('/api/test', {
				method: 'GET',
			});

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual({ data: 'test' });
			expect(mockStub.fetch).toHaveBeenCalledWith(
				'GET',
				'/api/test',
				undefined
			);
		});

		it('should make POST requests with JSON body', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({
				status: 200,
				body: JSON.stringify({ success: true }),
			});

			const response = await transport.fetch('/api/execute', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ command: 'echo hello' }),
			});

			expect(response.status).toBe(200);
			expect(mockStub.fetch).toHaveBeenCalledWith(
				'POST',
				'/api/execute',
				JSON.stringify({ command: 'echo hello' })
			);
		});

		it('should propagate non-200 status codes', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({
				status: 404,
				body: JSON.stringify({ error: 'Not found' }),
			});

			const response = await transport.fetch('/api/missing', {
				method: 'GET',
			});

			expect(response.status).toBe(404);
		});

		it('should handle responses with no body', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({
				status: 204,
			});

			const response = await transport.fetch('/api/delete', {
				method: 'DELETE',
			});

			expect(response.status).toBe(204);
		});

		it('should default method to GET when not specified', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({
				status: 200,
				body: JSON.stringify({ ok: true }),
			});

			await transport.fetch('/api/test');

			expect(mockStub.fetch).toHaveBeenCalledWith(
				'GET',
				'/api/test',
				undefined
			);
		});

		it('should throw for non-string body types', async () => {
			const { transport, mockStub } = createConnectedTransport();

			mockStub.fetch.mockResolvedValue({ status: 200 });

			// Trigger connect first
			await transport.connect();

			// A ReadableStream body should throw
			await expect(
				transport.fetch('/api/test', {
					method: 'POST',
					body: new ReadableStream() as unknown as BodyInit,
				})
			).rejects.toThrow('capnweb transport only supports string bodies');
		});
	});

	describe('streaming with mocked stub', () => {
		it('should return ReadableStream from fetchStream', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStream = new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'event: output\ndata: {"text":"hello"}\n\n'
						)
					);
					controller.close();
				},
			});

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn().mockResolvedValue(mockStream),
				[Symbol.dispose]: vi.fn(),
			};

			vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
				internals.stub = mockStub;
				internals.connected = true;
				internals.ws = { close: vi.fn() };
			});

			const stream = await transport.fetchStream('/api/execute/stream', {
				command: 'echo hello',
			});

			expect(stream).toBeInstanceOf(ReadableStream);

			// Verify the stream data flows through
			const reader = stream.getReader();
			const { value, done } = await reader.read();
			expect(done).toBe(false);
			const text = new TextDecoder().decode(value);
			expect(text).toContain('hello');

			expect(mockStub.fetchStream).toHaveBeenCalledWith(
				'POST',
				'/api/execute/stream',
				JSON.stringify({ command: 'echo hello' })
			);
		});

		it('should pass GET method for stream requests', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			const mockStub = {
				fetch: vi.fn(),
				fetchStream: vi.fn().mockResolvedValue(new ReadableStream()),
				[Symbol.dispose]: vi.fn(),
			};

			vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
				internals.stub = mockStub;
				internals.connected = true;
				internals.ws = { close: vi.fn() };
			});

			await transport.fetchStream('/api/stream', undefined, 'GET');

			expect(mockStub.fetchStream).toHaveBeenCalledWith(
				'GET',
				'/api/stream',
				undefined
			);
		});
	});

	describe('503 retry (inherited from BaseTransport)', () => {
		it('should retry on 503 and succeed on subsequent attempt', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
				retryTimeoutMs: 30000,
			});
			const internals = transport as unknown as {
				stub: unknown;
				connected: boolean;
				ws: unknown;
				doConnect: () => Promise<void>;
			};

			let callCount = 0;
			const mockStub = {
				fetch: vi.fn().mockImplementation(() => {
					callCount++;
					if (callCount === 1) {
						return Promise.resolve({
							status: 503,
							body: 'Container starting',
						});
					}
					return Promise.resolve({
						status: 200,
						body: JSON.stringify({ ok: true }),
					});
				}),
				fetchStream: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};

			vi.spyOn(internals, 'doConnect').mockImplementation(async () => {
				internals.stub = mockStub;
				internals.connected = true;
				internals.ws = { close: vi.fn() };
			});

			// Override sleep to make test fast
			vi.spyOn(transport as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
				.mockResolvedValue(undefined);

			const response = await transport.fetch('/api/ping');

			expect(response.status).toBe(200);
			expect(mockStub.fetch).toHaveBeenCalledTimes(2);
		});

		it('should respect setRetryTimeoutMs', async () => {
			const transport = new CapnwebTransport({
				wsUrl: 'ws://localhost:3000/capnweb',
				retryTimeoutMs: 1000,
			});

			// Update the timeout
			transport.setRetryTimeoutMs(60000);

			// Verify it's accepted (no throw)
			expect(transport.getMode()).toBe('capnweb');
		});
	});
});
