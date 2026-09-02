import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: {
    pack: "./packages/sandbox",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    dts: true,
    format: ["esm"],
  },
  run: {
    cache: true,
  },
});
