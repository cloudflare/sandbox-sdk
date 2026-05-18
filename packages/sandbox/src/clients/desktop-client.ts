import type {
  DesktopProcessHealth,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  SandboxDesktopAPI
} from '@repo/shared';
import { BaseHttpClient } from './base-client';
import type { BaseApiResponse } from './types';

export interface DesktopStartOptions {
  resolution?: [number, number];
  dpi?: number;
}

export interface ScreenshotOptions {
  format?: 'base64' | 'bytes';
  imageFormat?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  showCursor?: boolean;
}

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type KeyInput = string;

export interface TypeOptions {
  delay?: number;
}

export interface DesktopStartResponse extends BaseApiResponse {
  resolution: [number, number];
  dpi: number;
}

export interface DesktopStopResponse extends BaseApiResponse {}

export interface DesktopStatusResponse extends BaseApiResponse {
  status: 'active' | 'partial' | 'inactive';
  processes: Record<
    string,
    { running: boolean; pid?: number; uptime?: number }
  >;
  resolution: [number, number] | null;
  dpi: number | null;
}

export interface ScreenshotResponse extends BaseApiResponse {
  data: string;
  imageFormat: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

export interface ScreenshotBytesResponse extends BaseApiResponse {
  data: Uint8Array;
  imageFormat: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
}

export interface CursorPositionResponse extends BaseApiResponse {
  x: number;
  y: number;
}

export interface ScreenSizeResponse extends BaseApiResponse {
  width: number;
  height: number;
}

/**
 * Public interface for desktop operations.
 * Returned by `sandbox.desktop` via an RpcTarget wrapper so that pipelined
 * method calls work across the Durable Object RPC boundary.
 */
export interface Desktop {
  start(options?: DesktopStartOptions): Promise<DesktopStartResponse>;
  stop(): Promise<DesktopStopResponse>;
  status(): Promise<DesktopStatusResponse>;
  screenshot(options?: DesktopScreenshotRequest): Promise<ScreenshotResponse>;
  screenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<ScreenshotResponse>;
  click(x: number, y: number, options?: ClickOptions): Promise<void>;
  doubleClick(x: number, y: number, options?: ClickOptions): Promise<void>;
  tripleClick(x: number, y: number, options?: ClickOptions): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  middleClick(x: number, y: number): Promise<void>;
  mouseDown(x?: number, y?: number, options?: ClickOptions): Promise<void>;
  mouseUp(x?: number, y?: number, options?: ClickOptions): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: ClickOptions
  ): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount?: number
  ): Promise<void>;
  getCursorPosition(): Promise<CursorPositionResponse>;
  type(text: string, options?: TypeOptions): Promise<void>;
  press(key: KeyInput): Promise<void>;
  keyDown(key: KeyInput): Promise<void>;
  keyUp(key: KeyInput): Promise<void>;
  getScreenSize(): Promise<ScreenSizeResponse>;
  getProcessStatus(name: string): Promise<DesktopProcessHealth>;
}

/**
 * Client for desktop environment lifecycle, input, and screen operations
 */
export class DesktopClient extends BaseHttpClient implements SandboxDesktopAPI {
  /**
   * Start the desktop environment with optional resolution and DPI.
   */
  async start(options?: DesktopStartOptions): Promise<DesktopStartResponse> {
    try {
      const data = {
        ...(options?.resolution !== undefined && {
          resolution: options.resolution
        }),
        ...(options?.dpi !== undefined && { dpi: options.dpi })
      };

      const response = await this.post<DesktopStartResponse>(
        '/api/desktop/start',
        data
      );

      return response;
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Stop the desktop environment and all related processes.
   */
  async stop(): Promise<DesktopStopResponse> {
    try {
      const response = await this.post<DesktopStopResponse>(
        '/api/desktop/stop',
        {}
      );
      return response;
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Get desktop lifecycle and process health status.
   */
  async status(): Promise<DesktopStatusResponse> {
    const response = await this.get<DesktopStatusResponse>(
      '/api/desktop/status'
    );
    return response;
  }

  /**
   * Capture a full-screen screenshot as base64 (default).
   */
  async screenshot(
    options?: DesktopScreenshotRequest
  ): Promise<ScreenshotResponse> {
    const data = {
      format: 'base64',
      ...(options?.imageFormat !== undefined && {
        imageFormat: options.imageFormat
      }),
      ...(options?.quality !== undefined && { quality: options.quality }),
      ...(options?.showCursor !== undefined && {
        showCursor: options.showCursor
      })
    };
    return this.post<ScreenshotResponse>('/api/desktop/screenshot', data);
  }

  /**
   * Capture a region screenshot as base64.
   */
  async screenshotRegion(
    request: DesktopScreenshotRegionRequest
  ): Promise<ScreenshotResponse> {
    const { region, ...options } = request;
    const data = {
      region,
      format: 'base64',
      ...(options.imageFormat !== undefined && {
        imageFormat: options.imageFormat
      }),
      ...(options.quality !== undefined && { quality: options.quality }),
      ...(options.showCursor !== undefined && {
        showCursor: options.showCursor
      })
    };
    return this.post<ScreenshotResponse>(
      '/api/desktop/screenshot/region',
      data
    );
  }

  /**
   * Single-click at the given coordinates.
   */
  async click(x: number, y: number, options?: ClickOptions): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
      x,
      y,
      button: options?.button ?? 'left',
      clickCount: 1
    });
  }

  /**
   * Double-click at the given coordinates.
   */
  async doubleClick(
    x: number,
    y: number,
    options?: ClickOptions
  ): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
      x,
      y,
      button: options?.button ?? 'left',
      clickCount: 2
    });
  }

  /**
   * Triple-click at the given coordinates.
   */
  async tripleClick(
    x: number,
    y: number,
    options?: ClickOptions
  ): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
      x,
      y,
      button: options?.button ?? 'left',
      clickCount: 3
    });
  }

  /**
   * Right-click at the given coordinates.
   */
  async rightClick(x: number, y: number): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
      x,
      y,
      button: 'right',
      clickCount: 1
    });
  }

  /**
   * Middle-click at the given coordinates.
   */
  async middleClick(x: number, y: number): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
      x,
      y,
      button: 'middle',
      clickCount: 1
    });
  }

  /**
   * Press and hold a mouse button.
   */
  async mouseDown(
    x?: number,
    y?: number,
    options?: ClickOptions
  ): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/down', {
      ...(x !== undefined && { x }),
      ...(y !== undefined && { y }),
      button: options?.button ?? 'left'
    });
  }

  /**
   * Release a held mouse button.
   */
  async mouseUp(x?: number, y?: number, options?: ClickOptions): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/up', {
      ...(x !== undefined && { x }),
      ...(y !== undefined && { y }),
      button: options?.button ?? 'left'
    });
  }

  /**
   * Move the mouse cursor to coordinates.
   */
  async moveMouse(x: number, y: number): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/move', { x, y });
  }

  /**
   * Drag from start coordinates to end coordinates.
   */
  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    options?: ClickOptions
  ): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/drag', {
      startX,
      startY,
      endX,
      endY,
      button: options?.button ?? 'left'
    });
  }

  /**
   * Scroll at coordinates in the specified direction.
   */
  async scroll(
    x: number,
    y: number,
    direction: ScrollDirection,
    amount = 3
  ): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/mouse/scroll', {
      x,
      y,
      direction,
      amount
    });
  }

  /**
   * Get the current cursor coordinates.
   */
  async getCursorPosition(): Promise<CursorPositionResponse> {
    const response = await this.get<CursorPositionResponse>(
      '/api/desktop/mouse/position'
    );
    return response;
  }

  /**
   * Type text into the focused element.
   */
  async type(text: string, options?: TypeOptions): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/keyboard/type', {
      text,
      ...(options?.delay !== undefined && { delay: options.delay })
    });
  }

  /**
   * Press and release a key or key combination.
   */
  async press(key: KeyInput): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/keyboard/press', { key });
  }

  /**
   * Press and hold a key.
   */
  async keyDown(key: KeyInput): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/keyboard/down', { key });
  }

  /**
   * Release a held key.
   */
  async keyUp(key: KeyInput): Promise<void> {
    await this.post<BaseApiResponse>('/api/desktop/keyboard/up', { key });
  }

  /**
   * Get the active desktop screen size.
   */
  async getScreenSize(): Promise<ScreenSizeResponse> {
    const response = await this.get<ScreenSizeResponse>(
      '/api/desktop/screen/size'
    );
    return response;
  }

  /**
   * Get health status for a specific desktop process.
   */
  async getProcessStatus(name: string): Promise<DesktopProcessHealth> {
    return this.get<DesktopProcessHealth>(
      `/api/desktop/process/${encodeURIComponent(name)}/status`
    );
  }
}
