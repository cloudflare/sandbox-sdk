// Runs in a dedicated Bun Worker thread.
// Owns all koffi bindings to desktop.so (robotgo).
// Operations are serialized: one at a time, in order.

declare var self: Worker;

// koffi library handle — typed as unknown since koffi types are loaded dynamically
let lib: unknown = null;

interface DesktopBindings {
  move: (x: number, y: number) => void;
  moveSmooth: (x: number, y: number, low: number, high: number) => void;
  click: (button: string, dblClick: number) => void;
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
  ) => string;
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

    // Disposable string type: koffi reads the C string, then calls free() on the
    // pointer. Required because Go's C.CString() allocates via malloc and koffi's
    // default 'str' return type does not free the memory.
    const HeapStr = koffi.disposable('HeapStr', 'str');

    const koffiLib = lib as {
      func: (name: string, ret: unknown, args: unknown[]) => Function;
    };

    // Raw FFI bindings — out-pointer functions need wrapper logic.
    // koffi.out() is required so koffi copies values back from C to JS.
    const rawGetScreenSize = koffiLib.func('GetScreenSize', 'void', [
      koffi.out(koffi.pointer('int')),
      koffi.out(koffi.pointer('int'))
    ]);
    const rawGetMousePos = koffiLib.func('GetMousePos', 'void', [
      koffi.out(koffi.pointer('int')),
      koffi.out(koffi.pointer('int'))
    ]);

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
        'int'
      ]) as DesktopBindings['click'],
      scroll: koffiLib.func('Scroll', 'void', [
        'int',
        'int'
      ]) as DesktopBindings['scroll'],
      typeStr: koffiLib.func('TypeStr', 'void', [
        'str',
        'int'
      ]) as DesktopBindings['typeStr'],
      keyTap: koffiLib.func('KeyTap', HeapStr, [
        'str',
        'str'
      ]) as DesktopBindings['keyTap'],
      mouseDown: koffiLib.func('MouseDown', 'void', [
        'str'
      ]) as DesktopBindings['mouseDown'],
      mouseUp: koffiLib.func('MouseUp', 'void', [
        'str'
      ]) as DesktopBindings['mouseUp'],
      keyDown: koffiLib.func('KeyDown', 'void', [
        'str'
      ]) as DesktopBindings['keyDown'],
      keyUp: koffiLib.func('KeyUp', 'void', [
        'str'
      ]) as DesktopBindings['keyUp'],
      saveCapture: koffiLib.func('SaveCapture', HeapStr, [
        'str',
        'int',
        'int',
        'int',
        'int'
      ]) as DesktopBindings['saveCapture'],

      // Out-pointer wrappers: allocate output arrays and extract values
      getScreenSize: (() => {
        const w = [0],
          h = [0];
        rawGetScreenSize(w, h);
        return { width: w[0], height: h[0] };
      }) as DesktopBindings['getScreenSize'],

      getMousePos: (() => {
        const x = [0],
          y = [0];
        rawGetMousePos(x, y);
        return { x: x[0], y: y[0] };
      }) as DesktopBindings['getMousePos']
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
      case 'screenshot': {
        const sx = Math.max(0, args.x ?? 0);
        const sy = Math.max(0, args.y ?? 0);
        const sw = args.w ?? 0;
        const sh = args.h ?? 0;
        if (sw <= 0 || sh <= 0) {
          throw new Error(`Invalid screenshot dimensions: ${sw}x${sh}`);
        }
        const err = bindings.saveCapture!(args.path, sx, sy, sw, sh);
        if (err && err !== '') {
          throw new Error(`Screenshot capture failed: ${err}`);
        }
        result = { success: true, path: args.path };
        break;
      }
      case 'click': {
        const btn = args.button || 'left';
        const count = args.clickCount ?? 1;
        bindings.move!(args.x, args.y);
        if (count <= 2) {
          bindings.click!(btn, count === 2 ? 1 : 0);
        } else {
          // Triple-click and above: rapid single clicks (OS detects multi-click from timing)
          for (let i = 0; i < count; i++) {
            bindings.click!(btn, 0);
          }
        }
        result = { success: true };
        break;
      }
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
