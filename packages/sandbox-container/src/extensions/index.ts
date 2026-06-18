export { ExtensionBridge } from './bridge';
export { buildEchoManifest, ECHO_SIDECAR_SOURCE } from './echo-sidecar';
export { ExtensionHost } from './extension-host';
export {
  encodeFrame,
  type Frame,
  FrameDecoder,
  type RequestFrame,
  type SidecarFrame
} from './protocol';
export type {
  ExtensionAsset,
  ExtensionEventHandler,
  ExtensionHealth,
  ExtensionManifest
} from './types';
