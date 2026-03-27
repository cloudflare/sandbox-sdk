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
  delayMs?: number;
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
  screenshot(
    options?: ScreenshotOptions & { format?: 'base64' }
  ): Promise<ScreenshotResponse>;
  screenshot(
    options: ScreenshotOptions & { format: 'bytes' }
  ): Promise<ScreenshotBytesResponse>;
  screenshot(
    options?: ScreenshotOptions
  ): Promise<ScreenshotResponse | ScreenshotBytesResponse>;
  screenshotRegion(
    region: ScreenshotRegion,
    options?: ScreenshotOptions & { format?: 'base64' }
  ): Promise<ScreenshotResponse>;
  screenshotRegion(
    region: ScreenshotRegion,
    options: ScreenshotOptions & { format: 'bytes' }
  ): Promise<ScreenshotBytesResponse>;
  screenshotRegion(
    region: ScreenshotRegion,
    options?: ScreenshotOptions
  ): Promise<ScreenshotResponse | ScreenshotBytesResponse>;
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
  getProcessStatus(
    name: string
  ): Promise<
    BaseApiResponse & { running: boolean; pid?: number; uptime?: number }
  >;
}

/**
 * Client for desktop environment lifecycle, input, and screen operations
 */
export class DesktopClient extends BaseHttpClient {
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
    try {
      const response = await this.get<DesktopStatusResponse>(
        '/api/desktop/status'
      );
      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Capture a full-screen screenshot as base64 (default).
   */
  async screenshot(
    options?: ScreenshotOptions & { format?: 'base64' }
  ): Promise<ScreenshotResponse>;
  /**
   * Capture a full-screen screenshot as bytes.
   */
  async screenshot(
    options: ScreenshotOptions & { format: 'bytes' }
  ): Promise<ScreenshotBytesResponse>;
  async screenshot(
    options?: ScreenshotOptions
  ): Promise<ScreenshotResponse | ScreenshotBytesResponse> {
    try {
      const wantsBytes = options?.format === 'bytes';
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

      const response = await this.post<ScreenshotResponse>(
        '/api/desktop/screenshot',
        data
      );

      if (wantsBytes) {
        const binaryString = atob(response.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        return {
          ...response,
          data: bytes
        } as ScreenshotBytesResponse;
      }

      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Capture a region screenshot as base64 (default).
   */
  async screenshotRegion(
    region: ScreenshotRegion,
    options?: ScreenshotOptions & { format?: 'base64' }
  ): Promise<ScreenshotResponse>;
  /**
   * Capture a region screenshot as bytes.
   */
  async screenshotRegion(
    region: ScreenshotRegion,
    options: ScreenshotOptions & { format: 'bytes' }
  ): Promise<ScreenshotBytesResponse>;
  async screenshotRegion(
    region: ScreenshotRegion,
    options?: ScreenshotOptions
  ): Promise<ScreenshotResponse | ScreenshotBytesResponse> {
    try {
      const wantsBytes = options?.format === 'bytes';
      const data = {
        region,
        format: 'base64',
        ...(options?.imageFormat !== undefined && {
          imageFormat: options.imageFormat
        }),
        ...(options?.quality !== undefined && { quality: options.quality }),
        ...(options?.showCursor !== undefined && {
          showCursor: options.showCursor
        })
      };

      const response = await this.post<ScreenshotResponse>(
        '/api/desktop/screenshot/region',
        data
      );

      if (wantsBytes) {
        const binaryString = atob(response.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        return {
          ...response,
          data: bytes
        } as ScreenshotBytesResponse;
      }

      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Single-click at the given coordinates.
   */
  async click(x: number, y: number, options?: ClickOptions): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
        x,
        y,
        button: options?.button ?? 'left',
        clickCount: 1
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Double-click at the given coordinates.
   */
  async doubleClick(
    x: number,
    y: number,
    options?: ClickOptions
  ): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
        x,
        y,
        button: options?.button ?? 'left',
        clickCount: 2
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Triple-click at the given coordinates.
   */
  async tripleClick(
    x: number,
    y: number,
    options?: ClickOptions
  ): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
        x,
        y,
        button: options?.button ?? 'left',
        clickCount: 3
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Right-click at the given coordinates.
   */
  async rightClick(x: number, y: number): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
        x,
        y,
        button: 'right',
        clickCount: 1
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Middle-click at the given coordinates.
   */
  async middleClick(x: number, y: number): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/click', {
        x,
        y,
        button: 'middle',
        clickCount: 1
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Press and hold a mouse button.
   */
  async mouseDown(
    x?: number,
    y?: number,
    options?: ClickOptions
  ): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/down', {
        ...(x !== undefined && { x }),
        ...(y !== undefined && { y }),
        button: options?.button ?? 'left'
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Release a held mouse button.
   */
  async mouseUp(x?: number, y?: number, options?: ClickOptions): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/up', {
        ...(x !== undefined && { x }),
        ...(y !== undefined && { y }),
        button: options?.button ?? 'left'
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Move the mouse cursor to coordinates.
   */
  async moveMouse(x: number, y: number): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/move', { x, y });
    } catch (error) {
      throw error;
    }
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
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/drag', {
        startX,
        startY,
        endX,
        endY,
        button: options?.button ?? 'left'
      });
    } catch (error) {
      throw error;
    }
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
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/scroll', {
        x,
        y,
        direction,
        amount
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the current cursor coordinates.
   */
  async getCursorPosition(): Promise<CursorPositionResponse> {
    try {
      const response = await this.get<CursorPositionResponse>(
        '/api/desktop/mouse/position'
      );
      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Type text into the focused element.
   */
  async type(text: string, options?: TypeOptions): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/type', {
        text,
        ...(options?.delayMs !== undefined && { delayMs: options.delayMs })
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Press and release a key or key combination.
   */
  async press(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/press', { key });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Press and hold a key.
   */
  async keyDown(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/down', { key });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Release a held key.
   */
  async keyUp(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/up', { key });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the active desktop screen size.
   */
  async getScreenSize(): Promise<ScreenSizeResponse> {
    try {
      const response = await this.get<ScreenSizeResponse>(
        '/api/desktop/screen/size'
      );
      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get health status for a specific desktop process.
   */
  async getProcessStatus(
    name: string
  ): Promise<
    BaseApiResponse & { running: boolean; pid?: number; uptime?: number }
  > {
    try {
      const response = await this.get<
        BaseApiResponse & { running: boolean; pid?: number; uptime?: number }
      >(`/api/desktop/process/${encodeURIComponent(name)}/status`);

      return response;
    } catch (error) {
      throw error;
    }
  }
}
