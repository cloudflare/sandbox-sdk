import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type {
  DesktopCursorPosition,
  DesktopKeyPressRequest,
  DesktopMouseClickRequest,
  DesktopMouseDownRequest,
  DesktopMouseDragRequest,
  DesktopMouseMoveRequest,
  DesktopMouseScrollRequest,
  DesktopMouseUpRequest,
  DesktopProcessHealth,
  DesktopScreenSize,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopScreenshotResult,
  DesktopStartRequest,
  DesktopStartResult,
  DesktopStatusResult,
  DesktopStopResult,
  DesktopTypeRequest,
  Logger
} from '@repo/shared';
import type { ServiceResult } from '../core/types';
import { serviceError, serviceSuccess } from '../core/types';
import { DesktopManager } from '../managers/desktop-manager';

export class DesktopService {
  private manager: DesktopManager;
  private worker: Worker | null = null;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  constructor(private logger: Logger) {
    this.manager = new DesktopManager(logger);
  }

  async start(
    options?: DesktopStartRequest
  ): Promise<ServiceResult<DesktopStartResult>> {
    try {
      await this.manager.start(options);
      this.ensureWorkerRunning();
      const resolution = this.manager.getResolution() ?? [1024, 768];
      const dpi = this.manager.getDpi() ?? 96;

      return serviceSuccess<DesktopStartResult>({
        success: true,
        resolution,
        dpi
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Desktop start failed', undefined, { error: message });
      return serviceError({ message, code: 'DESKTOP_START_FAILED' });
    }
  }

  async stop(): Promise<ServiceResult<DesktopStopResult>> {
    try {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      for (const [, handler] of this.pending) {
        handler.reject(new Error('Desktop service stopped'));
      }
      this.pending.clear();

      await this.manager.stop();
      return serviceSuccess<DesktopStopResult>({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Desktop stop failed', undefined, { error: message });
      return serviceError({ message, code: 'DESKTOP_STOP_FAILED' });
    }
  }

  async status(): Promise<ServiceResult<DesktopStatusResult>> {
    const managerStatus = this.manager.getStatus();
    return serviceSuccess<DesktopStatusResult>({
      status: managerStatus.status,
      processes: managerStatus.processes,
      resolution: this.manager.getResolution(),
      dpi: this.manager.getDpi()
    });
  }

  async screenshot(
    options?: DesktopScreenshotRequest
  ): Promise<ServiceResult<DesktopScreenshotResult>> {
    try {
      this.ensureDesktopActive();
      const imageFormat = options?.imageFormat ?? 'png';
      const path = `/tmp/screenshot-${crypto.randomUUID()}.${imageFormat}`;
      const resolution = this.manager.getResolution() ?? [1024, 768];

      await this.sendToWorker('screenshot', {
        path,
        x: 0,
        y: 0,
        w: resolution[0],
        h: resolution[1]
      });

      const file = Bun.file(path);
      const buffer = await file.arrayBuffer();
      const data = Buffer.from(buffer).toString('base64');

      try {
        await unlink(path);
      } catch {}

      return serviceSuccess<DesktopScreenshotResult>({
        data,
        imageFormat,
        width: resolution[0],
        height: resolution[1]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_SCREENSHOT_FAILED' });
    }
  }

  async screenshotRegion(
    options: DesktopScreenshotRegionRequest
  ): Promise<ServiceResult<DesktopScreenshotResult>> {
    try {
      this.ensureDesktopActive();
      const imageFormat = options.imageFormat ?? 'png';
      const path = `/tmp/screenshot-${crypto.randomUUID()}.${imageFormat}`;
      const { x, y, width: w, height: h } = options.region;

      await this.sendToWorker('screenshot', { path, x, y, w, h });

      const file = Bun.file(path);
      const buffer = await file.arrayBuffer();
      const data = Buffer.from(buffer).toString('base64');

      try {
        await unlink(path);
      } catch {}

      return serviceSuccess<DesktopScreenshotResult>({
        data,
        imageFormat,
        width: w,
        height: h
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_SCREENSHOT_FAILED' });
    }
  }

  async click(request: DesktopMouseClickRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('click', {
        x: request.x,
        y: request.y,
        button: request.button ?? 'left',
        clickCount: request.clickCount ?? 1
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async moveMouse(
    request: DesktopMouseMoveRequest
  ): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('move', { x: request.x, y: request.y });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async mouseDown(
    request: DesktopMouseDownRequest
  ): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('mouseDown', {
        x: request.x,
        y: request.y,
        button: request.button ?? 'left'
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async mouseUp(request: DesktopMouseUpRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('mouseUp', {
        x: request.x,
        y: request.y,
        button: request.button ?? 'left'
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async drag(request: DesktopMouseDragRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('drag', {
        startX: request.startX,
        startY: request.startY,
        endX: request.endX,
        endY: request.endY,
        button: request.button ?? 'left'
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async scroll(
    request: DesktopMouseScrollRequest
  ): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();

      const amount = request.amount ?? 1;
      const scrollX =
        request.direction === 'left'
          ? -amount
          : request.direction === 'right'
            ? amount
            : 0;
      const scrollY =
        request.direction === 'up'
          ? amount
          : request.direction === 'down'
            ? -amount
            : 0;

      await this.sendToWorker('scroll', {
        x: request.x,
        y: request.y,
        scrollX,
        scrollY
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async getCursorPosition(): Promise<ServiceResult<DesktopCursorPosition>> {
    try {
      this.ensureDesktopActive();
      const result = (await this.sendToWorker('getMousePos')) as {
        x: number;
        y: number;
      };
      return serviceSuccess<DesktopCursorPosition>({
        x: result.x,
        y: result.y
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async typeText(request: DesktopTypeRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('type', { text: request.text, pid: 0 });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async keyPress(
    request: DesktopKeyPressRequest
  ): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      const parts = request.key.split('+');
      const key = parts.pop() ?? '';
      const modifiers = parts.join('+');
      await this.sendToWorker('keyTap', { key, modifiers });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async keyDown(request: DesktopKeyPressRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('keyDown', { key: request.key });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async keyUp(request: DesktopKeyPressRequest): Promise<ServiceResult<void>> {
    try {
      this.ensureDesktopActive();
      await this.sendToWorker('keyUp', { key: request.key });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_INPUT_FAILED' });
    }
  }

  async getScreenSize(): Promise<ServiceResult<DesktopScreenSize>> {
    try {
      this.ensureDesktopActive();
      const result = (await this.sendToWorker('getScreenSize')) as {
        width: number;
        height: number;
      };
      return serviceSuccess<DesktopScreenSize>({
        width: result.width,
        height: result.height
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return serviceError({ message, code: 'DESKTOP_UNAVAILABLE' });
    }
  }

  async getProcessStatus(
    name: string
  ): Promise<ServiceResult<DesktopProcessHealth>> {
    const managerStatus = this.manager.getStatus();
    const processHealth = managerStatus.processes[name];
    if (!processHealth) {
      return serviceError({
        message: `Process '${name}' not found`,
        code: 'DESKTOP_NOT_STARTED'
      });
    }
    return serviceSuccess<DesktopProcessHealth>(processHealth);
  }

  private ensureDesktopActive(): void {
    const { status } = this.manager.getStatus();
    if (status === 'inactive') {
      throw new Error('Desktop is not running. Call start() first.');
    }
  }

  private async sendToWorker(
    op: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    this.ensureWorkerRunning();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, op, ...args });
    });
  }

  private ensureWorkerRunning(): void {
    if (!this.worker) {
      // Compiled binary: worker is at /container-server/workers/desktop-worker.js
      // Dev mode: resolve relative to this source file via import.meta.url
      const compiledWorkerPath = '/container-server/workers/desktop-worker.js';
      const workerPath = existsSync(compiledWorkerPath)
        ? compiledWorkerPath
        : new URL('../workers/desktop-worker.ts', import.meta.url).href;
      this.worker = new Worker(workerPath);
      this.worker.onmessage = (event: MessageEvent) => {
        const { id, result, error } = event.data;
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          if (error) {
            handler.reject(new Error(error));
          } else {
            handler.resolve(result);
          }
        }
      };
      this.worker.onerror = (event) => {
        const message = event instanceof Error ? event.message : String(event);
        this.logger.error('Desktop worker crashed', undefined, { message });
        for (const [id, handler] of this.pending) {
          handler.reject(new Error(`Worker crashed: ${message}`));
          this.pending.delete(id);
        }
        this.worker = null;
      };
    }
  }

  async destroy(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    await this.manager.stop();
    for (const [, handler] of this.pending) {
      handler.reject(new Error('Desktop service destroyed'));
    }
    this.pending.clear();
  }
}
