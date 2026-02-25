// Runs in a dedicated Bun Worker thread.
// Owns all koffi bindings to desktop.so (robotgo).
// Operations are serialized: one at a time, in order.

declare var self: Worker;

// koffi library handle — typed as unknown since koffi types are loaded dynamically
let lib: unknown = null;

interface DesktopBindings {
  move: (x: number, y: number) => void;
  moveSmooth: (x: number, y: number, low: number, high: number) => void;
  click: (button: string, double: boolean) => void;
  scroll: (x: number, y: number) => void;
  typeStr: (text: string, pid: number) => void;
  keyTap: (key: string, modifiers: string) => string;
  getScreenSize: () => { width: number; height: number };
  saveCapture: (
    path: string,
    x: number,
    y: number,
    w: number,
    h: number
  ) => void;
  getMousePos: () => { x: number; y: number };
  mouseDown: (button: string) => void;
  mouseUp: (button: string) => void;
  keyDown: (key: string) => void;
  keyUp: (key: string) => void;
}

let bindings: Partial<DesktopBindings> = {};

function loadLibrary(): boolean {
  try {
    const koffi = require('koffi');
    lib = koffi.load('/usr/lib/desktop.so');

    // Type assertion is safe here: koffi.load returns an object with .func()
    const koffiLib = lib as {
      func: (name: string, ret: string, args: string[]) => Function;
    };

    bindings = {
      move: koffiLib.func('Move', 'void', [
        'int',
        'int'
      ]) as DesktopBindings['move'],
      moveSmooth: koffiLib.func('MoveSmooth', 'void', [
        'int',
        'int',
        'double',
        'double'
      ]) as DesktopBindings['moveSmooth'],
      click: koffiLib.func('Click', 'void', [
        'str',
        'bool'
      ]) as DesktopBindings['click'],
      scroll: koffiLib.func('Scroll', 'void', [
        'int',
        'int'
      ]) as DesktopBindings['scroll'],
      typeStr: koffiLib.func('TypeStr', 'void', [
        'str',
        'int'
      ]) as DesktopBindings['typeStr'],
      keyTap: koffiLib.func('KeyTap', 'str', [
        'str',
        'str'
      ]) as DesktopBindings['keyTap'],
      getScreenSize: koffiLib.func('GetScreenSize', 'void', [
        'int*',
        'int*'
      ]) as unknown as DesktopBindings['getScreenSize'],
      saveCapture: koffiLib.func('SaveCapture', 'void', [
        'str',
        'int',
        'int',
        'int',
        'int'
      ]) as DesktopBindings['saveCapture'],
      getMousePos: koffiLib.func('GetMousePos', 'void', [
        'int*',
        'int*'
      ]) as unknown as DesktopBindings['getMousePos'],
      mouseDown: koffiLib.func('MouseDown', 'void', [
        'str'
      ]) as DesktopBindings['mouseDown'],
      mouseUp: koffiLib.func('MouseUp', 'void', [
        'str'
      ]) as DesktopBindings['mouseUp'],
      keyDown: koffiLib.func('KeyDown', 'void', [
        'str'
      ]) as DesktopBindings['keyDown'],
      keyUp: koffiLib.func('KeyUp', 'void', ['str']) as DesktopBindings['keyUp']
    };
    return true;
  } catch (error) {
    return false;
  }
}

self.onmessage = (event: MessageEvent) => {
  const { id, op, ...args } = event.data;

  try {
    if (!lib && !loadLibrary()) {
      self.postMessage({ id, error: 'Desktop library not available' });
      return;
    }

    let result: unknown;
    switch (op) {
      case 'screenshot':
        bindings.saveCapture!(
          args.path,
          args.x ?? 0,
          args.y ?? 0,
          args.w ?? 0,
          args.h ?? 0
        );
        result = { success: true, path: args.path };
        break;
      case 'click':
        bindings.move!(args.x, args.y);
        bindings.click!(args.button || 'left', args.double || false);
        result = { success: true };
        break;
      case 'move':
        bindings.move!(args.x, args.y);
        result = { success: true };
        break;
      case 'moveSmooth':
        bindings.moveSmooth!(args.x, args.y, args.low ?? 5, args.high ?? 10);
        result = { success: true };
        break;
      case 'scroll':
        bindings.move!(args.x, args.y);
        bindings.scroll!(args.scrollX ?? 0, args.scrollY ?? 0);
        result = { success: true };
        break;
      case 'type':
        bindings.typeStr!(args.text, args.pid ?? 0);
        result = { success: true };
        break;
      case 'keyTap':
        bindings.keyTap!(args.key, args.modifiers ?? '');
        result = { success: true };
        break;
      case 'getScreenSize':
        result = bindings.getScreenSize!();
        break;
      case 'getMousePos':
        result = bindings.getMousePos!();
        break;
      case 'mouseDown':
        if (args.x !== undefined && args.y !== undefined) {
          bindings.move!(args.x, args.y);
        }
        bindings.mouseDown!(args.button || 'left');
        result = { success: true };
        break;
      case 'mouseUp':
        if (args.x !== undefined && args.y !== undefined) {
          bindings.move!(args.x, args.y);
        }
        bindings.mouseUp!(args.button || 'left');
        result = { success: true };
        break;
      case 'keyDown':
        bindings.keyDown!(args.key);
        result = { success: true };
        break;
      case 'keyUp':
        bindings.keyUp!(args.key);
        result = { success: true };
        break;
      case 'drag':
        bindings.move!(args.startX, args.startY);
        bindings.mouseDown!(args.button || 'left');
        bindings.moveSmooth!(args.endX, args.endY, 5, 10);
        bindings.mouseUp!(args.button || 'left');
        result = { success: true };
        break;
      default:
        self.postMessage({ id, error: `Unknown operation: ${op}` });
        return;
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
