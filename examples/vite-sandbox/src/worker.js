import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

const VITE_PORT = 5173;

export default {
	async fetch(request, env) {
		const proxiedResponse = await proxyToSandbox(request, env);
		if (proxiedResponse) {
			return proxiedResponse;
		}

		const url = new URL(request.url);

		if (url.pathname === "/api/sandbox") {
			return sandboxApi(url, env);
		}

		// Fallback to serving static assets.
		if (url.pathname.endsWith("/")) {
			url.pathname = `${url.pathname}index.html`;
			request = new Request(url.href, request);
		}
		return env.Assets.fetch(request);
	},
};

async function sandboxApi(url, env) {
	const sandbox = getSandbox(env.Sandbox, "vite-sandbox");

	const existingPort = await sandbox
		.getExposedPorts(url.host)
		.then((ports) => ports.find((p) => p.port === VITE_PORT));

	if (existingPort) {
		return Response.json({ url: `${existingPort.url}` });
	}

	const port = await sandbox.exposePort(VITE_PORT, { hostname: url.host });

	// TODO: Pass host and port to vite server via VITE_* env variables.
	await sandbox.startProcess("npm run dev", {
		processId: "vite-dev-server",
		cwd: "/app",
		env: {
			VITE_PORT: VITE_PORT,
			VITE_HMR_CLIENT_PORT: url.port,
		},
	});
	await sandbox.waitForPort({ portToCheck: VITE_PORT });

	return Response.json({ url: `${port.url}` });
}
