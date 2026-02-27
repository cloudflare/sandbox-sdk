import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  // server: {
  //   hmr: {
  //     port: 3001
  //   }
  // }
});
