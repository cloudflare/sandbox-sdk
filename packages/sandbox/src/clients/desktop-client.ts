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

      this.logSuccess(
        'Desktop started',
        `${response.resolution[0]}x${response.resolution[1]}`
      );

      return response;
    } catch (error) {
      this.logError('desktop.start', error);
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
      this.logSuccess('Desktop stopped');
      return response;
    } catch (error) {
      this.logError('desktop.stop', error);
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
      this.logSuccess('Desktop status retrieved', response.status);
      return response;
    } catch (error) {
      this.logError('desktop.status', error);
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

      this.logSuccess(
        'Screenshot captured',
        `${response.width}x${response.height}`
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
      this.logError('desktop.screenshot', error);
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

      this.logSuccess(
        'Region screenshot captured',
        `${region.width}x${region.height}`
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
      this.logError('desktop.screenshotRegion', error);
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

      this.logSuccess('Mouse click', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.click', error);
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

      this.logSuccess('Mouse double click', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.doubleClick', error);
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

      this.logSuccess('Mouse triple click', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.tripleClick', error);
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

      this.logSuccess('Mouse right click', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.rightClick', error);
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

      this.logSuccess('Mouse middle click', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.middleClick', error);
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

      this.logSuccess(
        'Mouse down',
        x !== undefined ? `(${x}, ${y})` : 'current position'
      );
    } catch (error) {
      this.logError('desktop.mouseDown', error);
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

      this.logSuccess(
        'Mouse up',
        x !== undefined ? `(${x}, ${y})` : 'current position'
      );
    } catch (error) {
      this.logError('desktop.mouseUp', error);
      throw error;
    }
  }

  /**
   * Move the mouse cursor to coordinates.
   */
  async moveMouse(x: number, y: number): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/mouse/move', { x, y });
      this.logSuccess('Mouse move', `(${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.moveMouse', error);
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

      this.logSuccess(
        'Mouse drag',
        `(${startX},${startY}) -> (${endX},${endY})`
      );
    } catch (error) {
      this.logError('desktop.drag', error);
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

      this.logSuccess('Mouse scroll', `${direction} ${amount} at (${x}, ${y})`);
    } catch (error) {
      this.logError('desktop.scroll', error);
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
      this.logSuccess(
        'Cursor position retrieved',
        `(${response.x}, ${response.y})`
      );
      return response;
    } catch (error) {
      this.logError('desktop.getCursorPosition', error);
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

      this.logSuccess('Keyboard type', `${text.length} chars`);
    } catch (error) {
      this.logError('desktop.type', error);
      throw error;
    }
  }

  /**
   * Press and release a key or key combination.
   */
  async press(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/press', { key });
      this.logSuccess('Key press', key);
    } catch (error) {
      this.logError('desktop.press', error);
      throw error;
    }
  }

  /**
   * Press and hold a key.
   */
  async keyDown(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/down', { key });
      this.logSuccess('Key down', key);
    } catch (error) {
      this.logError('desktop.keyDown', error);
      throw error;
    }
  }

  /**
   * Release a held key.
   */
  async keyUp(key: KeyInput): Promise<void> {
    try {
      await this.post<BaseApiResponse>('/api/desktop/keyboard/up', { key });
      this.logSuccess('Key up', key);
    } catch (error) {
      this.logError('desktop.keyUp', error);
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
      this.logSuccess(
        'Screen size retrieved',
        `${response.width}x${response.height}`
      );
      return response;
    } catch (error) {
      this.logError('desktop.getScreenSize', error);
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

      this.logSuccess('Desktop process status retrieved', name);
      return response;
    } catch (error) {
      this.logError('desktop.getProcessStatus', error);
      throw error;
    }
  }
}
