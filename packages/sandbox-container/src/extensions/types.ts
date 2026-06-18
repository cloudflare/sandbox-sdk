// The manifest/asset/health wire types are shared with the SDK so both sides
// agree on the contract. Re-exported here so host modules can import them from
// the local extensions package.
export type {
  ExtensionAsset,
  ExtensionHealth,
  ExtensionManifest
} from '@repo/shared';

/** Callback for streaming events surfaced from a sidecar during a call. */
export type ExtensionEventHandler = (
  event: string,
  data: unknown
) => void | Promise<void>;
