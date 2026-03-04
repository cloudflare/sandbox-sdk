import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import sandbox from "./vite.sandbox-plugin";

export default defineConfig({
	appType: "custom",
	plugins: [
		cloudflare({ experimental: { additionalPlugins: [sandbox()] } }),
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
