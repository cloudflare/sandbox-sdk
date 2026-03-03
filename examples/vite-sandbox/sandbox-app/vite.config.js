import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "/sandbox",
	plugins: [react()],
	server: {
		host: process.env.VITE_HOST ?? "0.0.0.0",
		port: process.env.VITE_PORT ?? 5173,
		hmr: {
			clientPort: process.env.VITE_HMR_CLIENT_POST ?? 3000,
		},
	},
});
