import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/containers": path.resolve(__dirname, "src/mock-containers.ts")
    }
  },
  plugins: [react(), cloudflare()]
});
