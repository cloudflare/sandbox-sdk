import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createNoOpLogger } from '@repo/shared';
import type { ErrorResponse } from '@repo/shared/errors';
import type { RequestContext } from '@sandbox-container/core/types';
import { DesktopHandler } from '@sandbox-container/handlers/desktop-handler';

const context: RequestContext = {
  sessionId: 'test-session',
  corsHeaders: {
    'Access-Control-Allow-Origin': '*'
  },
  requestId: 'req-1',
  timestamp: new Date()
};

describe('DesktopHandler', () => {
  type RouteCase = {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    methodName: keyof typeof mockService;
  };

  let mockService: {
    start: ReturnType<typeof mock>;
    stop: ReturnType<typeof mock>;
    status: ReturnType<typeof mock>;
    screenshot: ReturnType<typeof mock>;
    screenshotRegion: ReturnType<typeof mock>;
    click: ReturnType<typeof mock>;
    moveMouse: ReturnType<typeof mock>;
    mouseDown: ReturnType<typeof mock>;
    mouseUp: ReturnType<typeof mock>;
    drag: ReturnType<typeof mock>;
    scroll: ReturnType<typeof mock>;
    getCursorPosition: ReturnType<typeof mock>;
    typeText: ReturnType<typeof mock>;
    keyPress: ReturnType<typeof mock>;
    keyDown: ReturnType<typeof mock>;
    keyUp: ReturnType<typeof mock>;
    getScreenSize: ReturnType<typeof mock>;
    getProcessStatus: ReturnType<typeof mock>;
  };
  let handler: DesktopHandler;

  beforeEach(() => {
    mockService = {
      start: mock(() =>
        Promise.resolve({
          success: true,
          data: { success: true, resolution: [1920, 1080], dpi: 96 }
        })
      ),
      stop: mock(() =>
        Promise.resolve({ success: true, data: { success: true } })
      ),
      status: mock(() =>
        Promise.resolve({
          success: true,
          data: {
            success: true,
            status: 'active',
            processes: {},
            resolution: [1920, 1080],
            dpi: 96
          }
        })
      ),
      screenshot: mock(() =>
        Promise.resolve({
          success: true,
          data: {
            success: true,
            data: 'base64-image',
            imageFormat: 'png',
            width: 1920,
            height: 1080
          }
        })
      ),
      screenshotRegion: mock(() =>
        Promise.resolve({
          success: true,
          data: {
            success: true,
            data: 'base64-image',
            imageFormat: 'png',
            width: 400,
            height: 300
          }
        })
      ),
      click: mock(() => Promise.resolve({ success: true })),
      moveMouse: mock(() => Promise.resolve({ success: true })),
      mouseDown: mock(() => Promise.resolve({ success: true })),
      mouseUp: mock(() => Promise.resolve({ success: true })),
      drag: mock(() => Promise.resolve({ success: true })),
      scroll: mock(() => Promise.resolve({ success: true })),
      getCursorPosition: mock(() =>
        Promise.resolve({
          success: true,
          data: { success: true, x: 120, y: 300 }
        })
      ),
      typeText: mock(() => Promise.resolve({ success: true })),
      keyPress: mock(() => Promise.resolve({ success: true })),
      keyDown: mock(() => Promise.resolve({ success: true })),
      keyUp: mock(() => Promise.resolve({ success: true })),
      getScreenSize: mock(() =>
        Promise.resolve({
          success: true,
          data: { success: true, width: 1920, height: 1080 }
        })
      ),
      getProcessStatus: mock(() =>
        Promise.resolve({
          success: true,
          data: { healthy: true, running: true, pid: 1234 }
        })
      )
    };

    handler = new DesktopHandler(mockService as any, createNoOpLogger());
  });

  test('routes requests to the correct desktop service method', async () => {
    const routes: RouteCase[] = [
      {
        method: 'POST',
        path: '/api/desktop/start',
        body: { resolution: [1920, 1080] },
        methodName: 'start'
      },
      { method: 'POST', path: '/api/desktop/stop', methodName: 'stop' },
      { method: 'GET', path: '/api/desktop/status', methodName: 'status' },
      {
        method: 'POST',
        path: '/api/desktop/screenshot',
        body: { imageFormat: 'png' },
        methodName: 'screenshot'
      },
      {
        method: 'POST',
        path: '/api/desktop/mouse/click',
        body: { x: 50, y: 60, button: 'left' },
        methodName: 'click'
      },
      {
        method: 'POST',
        path: '/api/desktop/mouse/move',
        body: { x: 99, y: 100 },
        methodName: 'moveMouse'
      },
      {
        method: 'POST',
        path: '/api/desktop/keyboard/type',
        body: { text: 'hello world' },
        methodName: 'typeText'
      },
      {
        method: 'POST',
        path: '/api/desktop/keyboard/press',
        body: { key: 'Enter' },
        methodName: 'keyPress'
      },
      {
        method: 'GET',
        path: '/api/desktop/screen/size',
        methodName: 'getScreenSize'
      },
      {
        method: 'GET',
        path: '/api/desktop/process/xvfb/status',
        methodName: 'getProcessStatus'
      }
    ];

    for (const route of routes) {
      const request = new Request(`http://localhost${route.path}`, {
        method: route.method,
        body: route.body ? JSON.stringify(route.body) : undefined,
        headers: route.body ? { 'Content-Type': 'application/json' } : undefined
      });

      const response = await handler.handle(request, context);
      expect(response.status).toBe(200);
      expect(mockService[route.methodName]).toHaveBeenCalled();
    }
  });

  test('parses request body and passes body to service', async () => {
    const payload = { x: 123, y: 456, button: 'right', clickCount: 2 };
    const request = new Request('http://localhost/api/desktop/mouse/click', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handler.handle(request, context);
    expect(response.status).toBe(200);
    expect(mockService.click).toHaveBeenCalledWith(payload);
  });

  test('returns typed response with service data on success', async () => {
    const request = new Request('http://localhost/api/desktop/screenshot', {
      method: 'POST',
      body: JSON.stringify({ imageFormat: 'png' }),
      headers: { 'Content-Type': 'application/json' }
    });

    const response = await handler.handle(request, context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: 'base64-image',
      imageFormat: 'png',
      width: 1920,
      height: 1080
    });
  });

  test('forwards service error response when service fails', async () => {
    mockService.status = mock(() =>
      Promise.resolve({
        success: false,
        error: {
          code: 'DESKTOP_NOT_STARTED',
          message: 'Desktop is not running'
        }
      })
    );
    handler = new DesktopHandler(mockService as any, createNoOpLogger());

    const request = new Request('http://localhost/api/desktop/status', {
      method: 'GET'
    });

    const response = await handler.handle(request, context);
    const body = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(409);
    expect(body.code).toBe('DESKTOP_NOT_STARTED');
    expect(body.message).toBe('Desktop is not running');
  });

  test('returns error response for unknown route', async () => {
    const request = new Request('http://localhost/api/desktop/unknown', {
      method: 'GET'
    });

    const response = await handler.handle(request, context);
    const body = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(500);
    expect(body.code).toBe('UNKNOWN_ERROR');
    expect(body.message).toBe('Invalid desktop endpoint');
  });

  test('passes process name from process status route', async () => {
    const request = new Request(
      'http://localhost/api/desktop/process/xvfb/status',
      {
        method: 'GET'
      }
    );

    const response = await handler.handle(request, context);
    expect(response.status).toBe(200);
    expect(mockService.getProcessStatus).toHaveBeenCalledWith('xvfb');
  });
});
