// RPC-backed client (sole client implementation)
export { RPCSandboxClient } from './rpc-sandbox-client';

// Types needed by sandbox.ts (formerly in deleted client files)

export interface ExecuteResponse {
  success: boolean;
  timestamp: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

// Desktop types re-exported from @repo/shared
export type {
  DesktopCursorPosition as CursorPositionResponse,
  DesktopMouseButton,
  DesktopScreenSize as ScreenSizeResponse,
  DesktopScreenshotRegionRequest as ScreenshotRegion,
  DesktopScreenshotRequest as ScreenshotOptions,
  DesktopScreenshotResult as ScreenshotResponse,
  DesktopScrollDirection,
  DesktopStartRequest as DesktopStartOptions,
  DesktopStartResult as DesktopStartResponse,
  DesktopStatusResult as DesktopStatusResponse,
  DesktopStopResult as DesktopStopResponse
} from '@repo/shared';

// Desktop interface (public API)
export interface Desktop {
  start(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  screenshot(
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  screenshotRegion(
    region: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
  doubleClick(
    x: number,
    y: number,
    options?: Record<string, unknown>
  ): Promise<void>;
  tripleClick(
    x: number,
    y: number,
    options?: Record<string, unknown>
  ): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  middleClick(x: number, y: number): Promise<void>;
  mouseDown(
    x?: number,
    y?: number,
    options?: Record<string, unknown>
  ): Promise<void>;
  mouseUp(
    x?: number,
    y?: number,
    options?: Record<string, unknown>
  ): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: Record<string, unknown>
  ): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: string,
    amount?: number
  ): Promise<void>;
  getCursorPosition(): Promise<{ x: number; y: number }>;
  type(text: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  getScreenSize(): Promise<{ width: number; height: number }>;
  getProcessStatus(name: string): Promise<Record<string, unknown>>;
}
