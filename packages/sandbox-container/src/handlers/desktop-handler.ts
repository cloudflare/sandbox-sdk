import type {
  DesktopKeyPressRequest,
  DesktopMouseClickRequest,
  DesktopMouseDownRequest,
  DesktopMouseDragRequest,
  DesktopMouseMoveRequest,
  DesktopMouseScrollRequest,
  DesktopMouseUpRequest,
  DesktopScreenshotRegionRequest,
  DesktopScreenshotRequest,
  DesktopTypeRequest,
  Logger
} from '@repo/shared';
import { ErrorCode } from '@repo/shared/errors';
import type { RequestContext } from '../core/types';
import type { DesktopService } from '../services/desktop-service';
import { BaseHandler } from './base-handler';

export class DesktopHandler extends BaseHandler<Request, Response> {
  constructor(
    private desktopService: DesktopService,
    logger: Logger
  ) {
    super(logger);
  }

  async handle(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    switch (pathname) {
      case '/api/desktop/start':
        return this.handleStart(request, context);
      case '/api/desktop/stop':
        return this.handleStop(request, context);
      case '/api/desktop/status':
        return this.handleStatus(request, context);
      case '/api/desktop/screenshot':
        return this.handleScreenshot(request, context);
      case '/api/desktop/screenshot/region':
        return this.handleScreenshotRegion(request, context);
      case '/api/desktop/mouse/click':
        return this.handleMouseClick(request, context);
      case '/api/desktop/mouse/move':
        return this.handleMouseMove(request, context);
      case '/api/desktop/mouse/down':
        return this.handleMouseDown(request, context);
      case '/api/desktop/mouse/up':
        return this.handleMouseUp(request, context);
      case '/api/desktop/mouse/drag':
        return this.handleMouseDrag(request, context);
      case '/api/desktop/mouse/scroll':
        return this.handleMouseScroll(request, context);
      case '/api/desktop/mouse/position':
        return this.handleCursorPosition(request, context);
      case '/api/desktop/keyboard/type':
        return this.handleKeyboardType(request, context);
      case '/api/desktop/keyboard/press':
        return this.handleKeyboardPress(request, context);
      case '/api/desktop/keyboard/down':
        return this.handleKeyboardDown(request, context);
      case '/api/desktop/keyboard/up':
        return this.handleKeyboardUp(request, context);
      case '/api/desktop/screen/size':
        return this.handleScreenSize(request, context);
      default:
        if (
          pathname.startsWith('/api/desktop/process/') &&
          pathname.endsWith('/status')
        ) {
          return this.handleProcessStatus(request, context);
        }
        return this.createErrorResponse(
          {
            message: 'Invalid desktop endpoint',
            code: ErrorCode.UNKNOWN_ERROR
          },
          context
        );
    }
  }

  private async handleStart(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<{
      resolution?: [number, number];
      dpi?: number;
    }>(request);
    const result = await this.desktopService.start(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleStop(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.desktopService.stop();
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleStatus(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.desktopService.status();
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleScreenshot(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopScreenshotRequest>(request);
    const result = await this.desktopService.screenshot(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleScreenshotRegion(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body =
      await this.parseRequestBody<DesktopScreenshotRegionRequest>(request);
    const result = await this.desktopService.screenshotRegion(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleMouseClick(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopMouseClickRequest>(request);
    const result = await this.desktopService.click(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleMouseMove(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopMouseMoveRequest>(request);
    const result = await this.desktopService.moveMouse(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleMouseDown(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopMouseDownRequest>(request);
    const result = await this.desktopService.mouseDown(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleMouseUp(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopMouseUpRequest>(request);
    const result = await this.desktopService.mouseUp(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleMouseDrag(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopMouseDragRequest>(request);
    const result = await this.desktopService.drag(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleMouseScroll(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body =
      await this.parseRequestBody<DesktopMouseScrollRequest>(request);
    const result = await this.desktopService.scroll(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleCursorPosition(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.desktopService.getCursorPosition();
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleKeyboardType(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopTypeRequest>(request);
    const result = await this.desktopService.typeText(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleKeyboardPress(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopKeyPressRequest>(request);
    const result = await this.desktopService.keyPress(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleKeyboardDown(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopKeyPressRequest>(request);
    const result = await this.desktopService.keyDown(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleKeyboardUp(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const body = await this.parseRequestBody<DesktopKeyPressRequest>(request);
    const result = await this.desktopService.keyUp(body);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true }, context);
  }

  private async handleScreenSize(
    _request: Request,
    context: RequestContext
  ): Promise<Response> {
    const result = await this.desktopService.getScreenSize();
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse(result.data, context);
  }

  private async handleProcessStatus(
    request: Request,
    context: RequestContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const processName = decodeURIComponent(parts[4]);
    const result = await this.desktopService.getProcessStatus(processName);
    if (!result.success) return this.createErrorResponse(result.error, context);
    return this.createTypedResponse({ success: true, ...result.data }, context);
  }
}
