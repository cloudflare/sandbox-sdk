import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import sandbox from "./vite.sandbox-plugin";
import { writeFileSync } from "node:fs";

// Start bumping the value.js file every second.
function incrementCounter() {
	return {
		name: "host-counter",
		configureServer() {
			const COUNTER_PATH = "./src/value.js";

			let count = 0;

			setInterval(() => {
				count++;
				writeFileSync(COUNTER_PATH, `export const count = ${count};\n`);
			}, 1000);
		},
	};
}

export default defineConfig({
	appType: "custom",
	plugins: [
		cloudflare({ experimental: { additionalPlugins: [sandbox()] } }),
		react(),
		incrementCounter(),
	],
	server: {
		port: 3000,
		hmr: {
			// Set to different port to avoid any conflicts with sandbox.
			port: 3001,
		},
	},
});
