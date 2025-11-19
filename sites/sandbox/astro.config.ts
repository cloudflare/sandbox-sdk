import react from '@astrojs/react';
// import cloudflare from "@astrojs/cloudflare";
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  output: 'static',
  // adapter: cloudflare({
  //   platformProxy: {
  //     enabled: false
  //   }
  // }),
  vite: {
    // @ts-expect-error - TODO we need to fix this
    plugins: [tailwindcss()]
    // ssr: {
    //   external: ["react", "react-dom"]
    // }
  }
});
