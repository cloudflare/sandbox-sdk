/**
 * Type surface for the bridge's capnweb RPC interface.
 *
 * The RPC endpoint (`GET /v1/rpc`) exposes one top-level method:
 * `sandbox(id?)` returns a `SandboxRPCAPI` stub bound to that sandbox.
 * Sandbox-id validation and warm-pool resolution happen inside the call,
 * not in the URL — the wire path stays sandbox-agnostic so a single
 * WebSocket can address many sandboxes.
 *
 * `SandboxRPCAPI` mirrors the container's internal `SandboxAPI` so
 * consumers targeting the bridge get a familiar shape, but it lives in
 * the SDK rather than `@repo/shared` because it is a bridge-layer
 * concern.
 */

import type {
  SandboxBackupAPI,
  SandboxCommandsAPI,
  SandboxDesktopAPI,
  SandboxFilesAPI,
  SandboxGitAPI,
  SandboxInterpreterAPI,
  SandboxPortsAPI,
  SandboxProcessesAPI,
  SandboxUtilsAPI,
  SandboxWatchAPI
} from '@repo/shared';

/**
 * Top-level RPC interface exposed by `GET /v1/rpc`.
 *
 * Calling `sandbox(id?)` validates the sandbox ID (or generates a fresh
 * one if omitted), resolves a container via the warm pool, and returns a
 * `SandboxRPCAPI` stub. The returned stub exposes its bound id via the
 * `id` getter so callers can read back a generated value.
 */
export interface BridgeRPCAPI {
  sandbox(id?: string): Promise<SandboxRPCAPI>;
}

/**
 * Per-sandbox RPC surface. Structurally compatible with the container's
 * `SandboxAPI` so existing domain types from `@repo/shared` describe the
 * methods. The runtime implementation lives in `rpc-api.ts`.
 */
export interface SandboxRPCAPI {
  /** The sandbox ID this stub is bound to. */
  readonly id: string;
  commands: SandboxCommandsAPI;
  files: SandboxFilesAPI;
  processes: SandboxProcessesAPI;
  ports: SandboxPortsAPI;
  git: SandboxGitAPI;
  interpreter: SandboxInterpreterAPI;
  utils: SandboxUtilsAPI;
  backup: SandboxBackupAPI;
  desktop: SandboxDesktopAPI;
  watch: SandboxWatchAPI;
}

/** Subprotocol prefix for bearer-token auth on the RPC WebSocket endpoint. */
export const BRIDGE_RPC_BEARER_SUBPROTOCOL_PREFIX =
  'cloudflare-sandbox-bridge.bearer.';
