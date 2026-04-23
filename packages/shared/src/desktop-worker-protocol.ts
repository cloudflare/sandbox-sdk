/**
 * Protocol for communication between the DesktopService (in the container
 * HTTP server process) and the desktop worker child process.
 *
 * Messages are exchanged as newline-delimited JSON over the worker's
 * stdin (requests) and stdout (responses). The worker owns all koffi
 * bindings to desktop.so (robotgo) and serializes operations one at a time.
 *
 * Keeping this contract in the shared package ensures both sides agree on
 * the shape of every operation without resorting to `any` or unchecked casts.
 */

import type { DesktopMouseButton, DesktopScreenSize } from './desktop-types.js';

interface WithId {
  id: string;
}

export type DesktopWorkerRequest =
  | (WithId & {
      op: 'screenshot';
      path: string;
      x: number;
      y: number;
      w: number;
      h: number;
    })
  | (WithId & {
      op: 'click';
      x: number;
      y: number;
      button?: DesktopMouseButton;
      clickCount?: number;
    })
  | (WithId & { op: 'move'; x: number; y: number })
  | (WithId & {
      op: 'moveSmooth';
      x: number;
      y: number;
      low?: number;
      high?: number;
    })
  | (WithId & {
      op: 'scroll';
      x: number;
      y: number;
      scrollX?: number;
      scrollY?: number;
    })
  | (WithId & { op: 'type'; text: string; pid?: number })
  | (WithId & { op: 'keyTap'; key: string; modifiers?: string })
  | (WithId & { op: 'getScreenSize' })
  | (WithId & { op: 'getMousePos' })
  | (WithId & {
      op: 'mouseDown';
      x?: number;
      y?: number;
      button?: DesktopMouseButton;
    })
  | (WithId & {
      op: 'mouseUp';
      x?: number;
      y?: number;
      button?: DesktopMouseButton;
    })
  | (WithId & { op: 'keyDown'; key: string })
  | (WithId & { op: 'keyUp'; key: string })
  | (WithId & {
      op: 'drag';
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      button?: DesktopMouseButton;
    });

export type DesktopWorkerOp = DesktopWorkerRequest['op'];

/**
 * Per-op result shape. Operations that don't return meaningful data
 * return `{ success: true }` so the parent can await a confirmation.
 */
export interface DesktopWorkerResultMap {
  screenshot: { success: true; path: string };
  click: { success: true };
  move: { success: true };
  moveSmooth: { success: true };
  scroll: { success: true };
  type: { success: true };
  keyTap: { success: true };
  getScreenSize: DesktopScreenSize;
  getMousePos: { x: number; y: number };
  mouseDown: { success: true };
  mouseUp: { success: true };
  keyDown: { success: true };
  keyUp: { success: true };
  drag: { success: true };
}

export type DesktopWorkerResponse =
  | { id: string; result: DesktopWorkerResultMap[DesktopWorkerOp] }
  | { id: string; error: string };
