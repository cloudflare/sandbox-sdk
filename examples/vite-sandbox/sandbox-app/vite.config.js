import { writeFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function incrementCounter() {
  return {
    name: 'sandbox-counter',
    configureServer() {
      const COUNTER_PATH = './src/value.js';

      let count = 1000;

      setInterval(() => {
        count--;
        writeFileSync(COUNTER_PATH, `export const count = ${count};\n`);
      }, 1000);
    }
  };
}

export default defineConfig({
  base: process.env.VITE_BASE,
  plugins: [react(), incrementCounter()],
  server: {
    host: process.env.VITE_HOST ?? '0.0.0.0',
    port: process.env.VITE_PORT ?? 5173,
    hmr: {
      clientPort: process.env.VITE_HMR_CLIENT_PORT
    }
  }
});
