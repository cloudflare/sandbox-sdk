// Utility to detect runtime
const isDeno = typeof (globalThis as any).Deno !== "undefined" && typeof (globalThis as any).Deno.version !== "undefined";
const isBun = typeof (globalThis as any).Bun !== "undefined" && typeof (globalThis as any).Bun.version !== "undefined";
const isNode =
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof process.versions.node !== "undefined";

// Cross-platform "is main" check
export const isMain =
  (isDeno && (import.meta as any).main === true) ||
  (isBun &&
    typeof (import.meta as any).path === "string" &&
    (globalThis as any).Bun?.main === (import.meta as any).path) ||
  (isNode &&
    typeof require !== "undefined" &&
    typeof module !== "undefined" &&
    require.main === module);