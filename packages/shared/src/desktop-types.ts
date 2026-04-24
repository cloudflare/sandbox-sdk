/**
 * Desktop environment types shared between SDK and container runtime.
 *
 * The desktop stack (Xvfb → XFCE4 → x11vnc → noVNC) is managed by the
 * container-side DesktopManager. These types define the HTTP API contract
 * between the SDK's DesktopClient and the container's DesktopHandler.
 */

// === Lifecycle ===

export interface DesktopStartRequest {
  resolution?: [number, number];
  dpi?: number;
}

export interface DesktopStartResult {
  success: boolean;
  resolution: [number, number];
  dpi: number;
}

export interface DesktopStopResult {
  success: boolean;
}

export interface DesktopStatusResult {
  success: boolean;
  status: 'active' | 'partial' | 'inactive';
  processes: Record<string, DesktopProcessHealth>;
  resolution: [number, number] | null;
  dpi: number | null;
}

export interface DesktopProcessHealth {
  running: boolean;
  pid?: number;
  uptime?: number;
}

// === Screenshots ===

export type DesktopImageFormat = 'png' | 'jpeg' | 'webp';

export interface DesktopScreenshotRequest {
  format?: 'base64';
  imageFormat?: DesktopImageFormat;
  quality?: number;
  showCursor?: boolean;
}

export interface DesktopScreenshotRegionRequest extends DesktopScreenshotRequest {
  region: DesktopScreenshotRegion;
}

export interface DesktopScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopScreenshotResult {
  success: boolean;
  data: string;
  imageFormat: DesktopImageFormat;
  width: number;
  height: number;
}

// === Mouse ===

export type DesktopMouseButton = 'left' | 'right' | 'middle';
export type DesktopScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface DesktopMouseClickRequest {
  x: number;
  y: number;
  button?: DesktopMouseButton;
  clickCount?: number;
}

export interface DesktopMouseMoveRequest {
  x: number;
  y: number;
}

export interface DesktopMouseDownRequest {
  x?: number;
  y?: number;
  button?: DesktopMouseButton;
}

export interface DesktopMouseUpRequest {
  x?: number;
  y?: number;
  button?: DesktopMouseButton;
}

export interface DesktopMouseDragRequest {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  button?: DesktopMouseButton;
}

export interface DesktopMouseScrollRequest {
  x: number;
  y: number;
  direction: DesktopScrollDirection;
  amount?: number;
}

export interface DesktopCursorPosition {
  success: boolean;
  x: number;
  y: number;
}

// === Keyboard ===

/**
 * Key input accepts EITHER a single key name OR a '+'-separated combination.
 * The container parses combinations internally.
 *
 * Single keys: 'Return', 'Tab', 'Escape', 'BackSpace', 'space',
 *              'Up', 'Down', 'Left', 'Right', 'F1'-'F12', 'a'-'z', '0'-'9'
 *
 * Combinations: 'ctrl+c', 'ctrl+shift+t', 'alt+F4', 'super+d'
 *
 * Modifier names: 'ctrl', 'alt', 'shift', 'super' (also 'meta', 'cmd')
 */
export type DesktopKeyInput = string;

export interface DesktopKeyPressRequest {
  key: DesktopKeyInput;
}

export interface DesktopTypeRequest {
  text: string;
  delayMs?: number;
}

// === Screen Info ===

export interface DesktopScreenSize {
  success: boolean;
  width: number;
  height: number;
}
