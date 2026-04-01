import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CursorPositionResponse,
  DesktopStartResponse,
  DesktopStatusResponse,
  DesktopStopResponse,
  ScreenSizeResponse,
  ScreenshotResponse
} from '../src/clients';
import { DesktopClient } from '../src/clients/desktop-client';
import { SandboxError } from '../src/errors';

describe('DesktopClient', () => {
  let client: DesktopClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    onError = vi.fn();

    client = new DesktopClient({
      baseUrl: 'http://test.com',
      port: 3000,
      onError
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('should start the desktop environment with default options', async () => {
      const mockResponse: DesktopStartResponse = {
        success: true,
        resolution: [1024, 768],
        dpi: 96,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.start();

      expect(result.success).toBe(true);
      expect(result.resolution).toEqual([1024, 768]);
      expect(result.dpi).toBe(96);
    });

    it('should start the desktop with custom resolution and DPI', async () => {
      const mockResponse: DesktopStartResponse = {
        success: true,
        resolution: [1920, 1080],
        dpi: 144,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.start({
        resolution: [1920, 1080],
        dpi: 144
      });

      expect(result.success).toBe(true);
      expect(result.resolution).toEqual([1920, 1080]);
      expect(result.dpi).toBe(144);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.resolution).toEqual([1920, 1080]);
      expect(body.dpi).toBe(144);
    });

    it('should omit undefined options from the start request body', async () => {
      const mockResponse: DesktopStartResponse = {
        success: true,
        resolution: [1024, 768],
        dpi: 96,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.start();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).toEqual({});
    });

    it('should call onError callback when start fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(client.start()).rejects.toThrow('Connection refused');
      expect(onError).toHaveBeenCalledWith('Connection refused');
    });

    it('should stop the desktop environment', async () => {
      const mockResponse: DesktopStopResponse = {
        success: true,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.stop();

      expect(result.success).toBe(true);
    });

    it('should call onError callback when stop fails', async () => {
      mockFetch.mockRejectedValue(new Error('Desktop not running'));

      await expect(client.stop()).rejects.toThrow('Desktop not running');
      expect(onError).toHaveBeenCalledWith('Desktop not running');
    });

    it('should retrieve desktop status', async () => {
      const mockResponse: DesktopStatusResponse = {
        success: true,
        status: 'active',
        processes: {
          xvfb: { running: true, pid: 100, uptime: 3600 },
          vnc: { running: true, pid: 101, uptime: 3600 },
          noVNC: { running: true, pid: 102, uptime: 3600 }
        },
        resolution: [1024, 768],
        dpi: 96,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.status();

      expect(result.success).toBe(true);
      expect(result.status).toBe('active');
      expect(result.processes.xvfb.running).toBe(true);
      expect(result.resolution).toEqual([1024, 768]);
    });

    it('should handle inactive desktop status', async () => {
      const mockResponse: DesktopStatusResponse = {
        success: true,
        status: 'inactive',
        processes: {
          xvfb: { running: false },
          vnc: { running: false },
          noVNC: { running: false }
        },
        resolution: null,
        dpi: null,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.status();

      expect(result.status).toBe('inactive');
      expect(result.resolution).toBeNull();
      expect(result.dpi).toBeNull();
    });
  });

  describe('screenshots', () => {
    it('should capture a full-screen screenshot as base64', async () => {
      const mockResponse: ScreenshotResponse = {
        success: true,
        data: 'iVBORw0KGgoAAAANS',
        imageFormat: 'png',
        width: 1024,
        height: 768,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.screenshot();

      expect(result.data).toBe('iVBORw0KGgoAAAANS');
      expect(result.imageFormat).toBe('png');
      expect(result.width).toBe(1024);
      expect(result.height).toBe(768);
    });

    it('should capture a screenshot as bytes', async () => {
      // Base64 for "hello" = "aGVsbG8="
      const mockResponse: ScreenshotResponse = {
        success: true,
        data: 'aGVsbG8=',
        imageFormat: 'png',
        width: 1024,
        height: 768,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.screenshot({ format: 'bytes' });

      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.imageFormat).toBe('png');
      expect(result.width).toBe(1024);
    });

    it('should pass screenshot options to the request', async () => {
      const mockResponse: ScreenshotResponse = {
        success: true,
        data: 'abc',
        imageFormat: 'jpeg',
        width: 1024,
        height: 768,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.screenshot({
        imageFormat: 'jpeg',
        quality: 80,
        showCursor: true
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.imageFormat).toBe('jpeg');
      expect(body.quality).toBe(80);
      expect(body.showCursor).toBe(true);
    });

    it('should capture a region screenshot', async () => {
      const mockResponse: ScreenshotResponse = {
        success: true,
        data: 'regionData',
        imageFormat: 'png',
        width: 200,
        height: 100,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.screenshotRegion({
        x: 50,
        y: 50,
        width: 200,
        height: 100
      });

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.region).toEqual({
        x: 50,
        y: 50,
        width: 200,
        height: 100
      });
    });

    it('should capture a region screenshot as bytes', async () => {
      const mockResponse: ScreenshotResponse = {
        success: true,
        data: 'aGVsbG8=',
        imageFormat: 'webp',
        width: 300,
        height: 200,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.screenshotRegion(
        { x: 0, y: 0, width: 300, height: 200 },
        { format: 'bytes' }
      );

      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.imageFormat).toBe('webp');
    });
  });

  describe('mouse operations', () => {
    it('should perform a left click', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.click(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).toEqual({
        x: 100,
        y: 200,
        button: 'left',
        clickCount: 1
      });
    });

    it('should perform a click with custom button', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.click(50, 75, { button: 'right' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.button).toBe('right');
    });

    it('should perform a double click', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.doubleClick(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.clickCount).toBe(2);
      expect(body.button).toBe('left');
    });

    it('should perform a triple click', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.tripleClick(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.clickCount).toBe(3);
    });

    it('should perform a right click', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.rightClick(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.button).toBe('right');
      expect(body.clickCount).toBe(1);
    });

    it('should perform a middle click', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.middleClick(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.button).toBe('middle');
    });

    it('should press mouse button down at coordinates', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.mouseDown(100, 200);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.x).toBe(100);
      expect(body.y).toBe(200);
      expect(body.button).toBe('left');
    });

    it('should press mouse button down at current position', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.mouseDown();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.x).toBeUndefined();
      expect(body.y).toBeUndefined();
    });

    it('should release mouse button', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.mouseUp(100, 200, { button: 'right' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.x).toBe(100);
      expect(body.y).toBe(200);
      expect(body.button).toBe('right');
    });

    it('should move the mouse cursor', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.moveMouse(500, 300);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).toEqual({ x: 500, y: 300 });
    });

    it('should drag from start to end coordinates', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.drag(10, 20, 300, 400);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).toEqual({
        startX: 10,
        startY: 20,
        endX: 300,
        endY: 400,
        button: 'left'
      });
    });

    it('should scroll at coordinates', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.scroll(100, 200, 'down', 5);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body).toEqual({
        x: 100,
        y: 200,
        direction: 'down',
        amount: 5
      });
    });

    it('should scroll with default amount', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.scroll(100, 200, 'up');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.amount).toBe(3);
    });

    it('should get cursor position', async () => {
      const mockResponse: CursorPositionResponse = {
        success: true,
        x: 512,
        y: 384,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getCursorPosition();

      expect(result.x).toBe(512);
      expect(result.y).toBe(384);
    });
  });

  describe('keyboard operations', () => {
    it('should type text', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.type('Hello, World!');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.text).toBe('Hello, World!');
    });

    it('should type text with delay', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.type('slow typing', { delayMs: 50 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.text).toBe('slow typing');
      expect(body.delayMs).toBe(50);
    });

    it('should press a key', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.press('Enter');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.key).toBe('Enter');
    });

    it('should press a key combination', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.press('ctrl+c');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.key).toBe('ctrl+c');
    });

    it('should hold a key down', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.keyDown('Shift');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.key).toBe('Shift');
    });

    it('should release a held key', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            timestamp: '2023-01-01T00:00:00Z'
          }),
          { status: 200 }
        )
      );

      await client.keyUp('Shift');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.key).toBe('Shift');
    });
  });

  describe('screen information', () => {
    it('should get screen size', async () => {
      const mockResponse: ScreenSizeResponse = {
        success: true,
        width: 1920,
        height: 1080,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getScreenSize();

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it('should get desktop process status', async () => {
      const mockResponse = {
        success: true,
        running: true,
        pid: 12345,
        uptime: 7200,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      const result = await client.getProcessStatus('xvfb');

      expect(result.running).toBe(true);
      expect(result.pid).toBe(12345);
      expect(result.uptime).toBe(7200);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/desktop/process/xvfb/status');
    });

    it('should encode process names in the URL', async () => {
      const mockResponse = {
        success: true,
        running: false,
        timestamp: '2023-01-01T00:00:00Z'
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(mockResponse), { status: 200 })
      );

      await client.getProcessStatus('my process');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/desktop/process/my%20process/status');
    });
  });

  describe('error handling', () => {
    it('should handle container-level errors with proper error mapping', async () => {
      const errorResponse = {
        code: 'DESKTOP_NOT_STARTED',
        message: 'Desktop environment is not running',
        context: {},
        httpStatus: 409,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 409 })
      );

      await expect(client.screenshot()).rejects.toThrow(SandboxError);
    });

    it('should handle network failures gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network connection failed'));

      await expect(client.click(0, 0)).rejects.toThrow(
        'Network connection failed'
      );
    });

    it('should handle malformed server responses', async () => {
      mockFetch.mockResolvedValue(
        new Response('invalid json {', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(client.status()).rejects.toThrow(SandboxError);
    });

    it('should handle server errors', async () => {
      const errorResponse = {
        code: 'INTERNAL_ERROR',
        message: 'Xvfb crashed unexpectedly',
        context: {},
        httpStatus: 500,
        timestamp: new Date().toISOString()
      };

      mockFetch.mockResolvedValue(
        new Response(JSON.stringify(errorResponse), { status: 500 })
      );

      await expect(client.start()).rejects.toThrow(SandboxError);
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('constructor options', () => {
    it('should initialize with minimal options', () => {
      const minimalClient = new DesktopClient();
      expect(minimalClient).toBeDefined();
    });

    it('should initialize with full options', () => {
      const fullClient = new DesktopClient({
        baseUrl: 'http://custom.com',
        port: 8080,
        onError: vi.fn()
      });
      expect(fullClient).toBeDefined();
    });

    it('should work without onError callback', async () => {
      const clientWithoutCallbacks = new DesktopClient({
        baseUrl: 'http://test.com',
        port: 3000
      });

      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await expect(clientWithoutCallbacks.start()).rejects.toThrow(
        'Connection refused'
      );
    });
  });
});
