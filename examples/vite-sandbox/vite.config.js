import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	// Disable any HTML handling in favor of letting the worker do everything.
	appType: "custom",
	plugins: [cloudflare(), react()],
	server: {
		port: "3000",
		hmr: {
			// Set to different port to server to avoid any conflicts with sandbox.
			port: 3001,
		},
	},
});
