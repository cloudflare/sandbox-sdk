import { cloudflare, createPlugin } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { WebSocketServer } from "ws";
import { CoreHeaders, coupleWebSocket } from "miniflare";

// Convert nodejs headers to web standards.
export function createHeaders(req) {
	const headers = new Headers();
	const rawHeaders = req.rawHeaders;
	for (let i = 0; i < rawHeaders.length; i += 2) {
		if (rawHeaders[i].startsWith(":")) continue;
		headers.append(rawHeaders[i], rawHeaders[i + 1]);
	}

	return headers;
}

const sandbox = createPlugin("sandbox", (ctx) => ({
	configureServer(server) {
		const entryWorkerConfig = ctx.entryWorkerConfig;
		const entryWorkerName = entryWorkerConfig.name;

		// Register middleware before default middleware.
		server.middlewares.use(async (req, res, next) => {
			console.log("request", req.url);
			const port = server.httpServer.address()?.port ?? 3000;
			const pattern = new URLPattern(
				`http://:port(\\d{4,})-:sandbox-:token.localhost:${port}`,
			);

			// If the inbound request matches a sandbox preview URL forward it on...
			if (pattern.test(req.url)) {
				req.headers.set(CoreHeaders.ROUTE_OVERRIDE, entryWorkerName);
				return ctx.miniflare.dispatchFetch(req, { redirect: "manual" });
			}
			next();
		});

		// Handle sandbox HMR websocket upgrade. This assumes that the HMR for the host
		// server is running on a different port.
		const nodeWebSocket = new WebSocketServer({ noServer: true });
		server.httpServer.on("upgrade", async (request, socket, head) => {
			try {
				const url = new URL(request.url, `http://${request.headers.host}`);
				const port = server.httpServer.address()?.port ?? 3000;
				const pattern = new URLPattern(
					`http://:port(\\d{4,})-:sandbox-:token.localhost:${port}`,
				);
				if (!pattern.test(url.href)) {
					return;
				}

				// Socket errors crash Node.js if unhandled
				socket.on("error", () => socket.destroy());

				const headers = createHeaders(request);
				headers.set(CoreHeaders.ROUTE_OVERRIDE, entryWorkerName);

				console.log("upgrade in flight", url);
				const response = await ctx.miniflare.dispatchFetch(url, {
					headers,
					method: request.method,
				});
				const workerWebSocket = response.webSocket;

				if (!workerWebSocket) {
					socket.destroy();
					return;
				}

				nodeWebSocket.handleUpgrade(
					request,
					socket,
					head,
					async (clientWebSocket) => {
						void coupleWebSocket(clientWebSocket, workerWebSocket);
						nodeWebSocket.emit("connection", clientWebSocket, request);
					},
				);
			} catch (err) {
				console.error(err);
			}
		});
	},
}));

export default defineConfig({
	plugins: [
		cloudflare({ experimental: { additionalPlugins: [sandbox] } }),
		react(),
	],
	server: {
		port: 3000,
		hmr: {
			// Set to different port to server to avoid any conflicts with sandbox.
			port: 3001,
		},
	},
});
