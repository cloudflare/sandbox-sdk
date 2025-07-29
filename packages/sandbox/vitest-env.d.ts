declare module "vitest" {
  interface ProvidedContext {
    containerBuildId: string;
    containerReady: boolean;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    NODE_ENV: string;
    CONTAINER_BUILD_ID: string;
    CONTAINER_READY: boolean;
  }
}