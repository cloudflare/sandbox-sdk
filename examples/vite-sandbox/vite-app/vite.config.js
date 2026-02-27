import { defineConfig } from "vite";

export default defineConfig({
  base: "/sandbox",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      // protocol: "ws",
      // host: "5173-vite-sandbox-qkv9cgnqgickiphm.localhost",
      // clientPort: 3000
    }
  }
});
