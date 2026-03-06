// Runs in a dedicated Bun Worker thread.
// Owns all koffi bindings to desktop.so (robotgo).
// Operations are serialized: one at a time, in order.

declare var self: Worker;

// koffi library handle — typed as unknown since koffi types are loaded dynamically
let lib: unknown = null;

interface DesktopBindings {
  move: (x: number, y: number) => string;
  moveSmooth: (x: number, y: number, low: number, high: number) => string;
  click: (button: string, count: number) => string;
  scroll: (x: number, y: number) => string;
  typeText: (text: string, pid: number) => string;
  keyTap: (key: string, modifiers: string) => string;
  getScreenSize: () => { width: number; height: number };
  screenshot: (
    path: string,
    x: number,
    y: number,
    w: number,
    h: number
  ) => string;
  getMousePos: () => { x: number; y: number };
  mouseDown: (button: string) => string;
  mouseUp: (button: string) => string;
  keyDown: (key: string) => string;
  keyUp: (key: string) => string;
}

let bindings: Partial<DesktopBindings> = {};
let loadError: string | null = null;

function checkError(err: string, operation: string): void {
  if (err) {
    throw new Error(`${operation} failed: ${err}`);
  }
}

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
    const IntOut = koffi.out(koffi.pointer('int'));
    const rawGetScreenSize = koffiLib.func('GetScreenSize', 'void', [
      IntOut,
      IntOut
    ]);
    const rawGetMousePos = koffiLib.func('GetMousePos', 'void', [
      IntOut,
      IntOut
    ]);

    bindings = {
      move: koffiLib.func('Move', HeapStr, [
        'int',
        'int'
      ]) as DesktopBindings['move'],
      moveSmooth: koffiLib.func('MoveSmooth', HeapStr, [
        'int',
        'int',
        'double',
        'double'
      ]) as DesktopBindings['moveSmooth'],
      click: koffiLib.func('Click', HeapStr, [
        'str',
        'int'
      ]) as DesktopBindings['click'],
      scroll: koffiLib.func('Scroll', HeapStr, [
        'int',
        'int'
      ]) as DesktopBindings['scroll'],
      typeText: koffiLib.func('TypeText', HeapStr, [
        'str',
        'int'
      ]) as DesktopBindings['typeText'],
      keyTap: koffiLib.func('KeyTap', HeapStr, [
        'str',
        'str'
      ]) as DesktopBindings['keyTap'],
      mouseDown: koffiLib.func('MouseDown', HeapStr, [
        'str'
      ]) as DesktopBindings['mouseDown'],
      mouseUp: koffiLib.func('MouseUp', HeapStr, [
        'str'
      ]) as DesktopBindings['mouseUp'],
      keyDown: koffiLib.func('KeyDown', HeapStr, [
        'str'
      ]) as DesktopBindings['keyDown'],
      keyUp: koffiLib.func('KeyUp', HeapStr, [
        'str'
      ]) as DesktopBindings['keyUp'],
      screenshot: koffiLib.func('Screenshot', HeapStr, [
        'str',
        'int',
        'int',
        'int',
        'int'
      ]) as DesktopBindings['screenshot'],

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
    loadError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

self.onmessage = (event: MessageEvent) => {
  const { id, op, ...args } = event.data;

  try {
    if (!lib && !loadLibrary()) {
      self.postMessage({
        id,
        error: `Desktop library not available: ${loadError}`
      });
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
        checkError(
          bindings.screenshot!(args.path, sx, sy, sw, sh),
          'Screenshot'
        );
        result = { success: true, path: args.path };
        break;
      }
      case 'click': {
        const btn = args.button || 'left';
        const count = args.clickCount ?? 1;
        checkError(
          bindings.move!(Math.trunc(args.x), Math.trunc(args.y)),
          'Move'
        );
        checkError(bindings.click!(btn, count), 'Click');
        result = { success: true };
        break;
      }
      case 'move':
        checkError(
          bindings.move!(Math.trunc(args.x), Math.trunc(args.y)),
          'Move'
        );
        result = { success: true };
        break;
      case 'moveSmooth': {
        const mx = Math.trunc(args.x);
        const my = Math.trunc(args.y);
        checkError(
          bindings.moveSmooth!(mx, my, args.low ?? 5, args.high ?? 10),
          `MoveSmooth(${mx}, ${my})`
        );
        result = { success: true };
        break;
      }
      case 'scroll':
        checkError(
          bindings.move!(Math.trunc(args.x), Math.trunc(args.y)),
          'Move'
        );
        checkError(
          bindings.scroll!(args.scrollX ?? 0, args.scrollY ?? 0),
          'Scroll'
        );
        result = { success: true };
        break;
      case 'type':
        checkError(bindings.typeText!(args.text, args.pid ?? 0), 'TypeText');
        result = { success: true };
        break;
      case 'keyTap':
        checkError(bindings.keyTap!(args.key, args.modifiers ?? ''), 'KeyTap');
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
          checkError(
            bindings.move!(Math.trunc(args.x), Math.trunc(args.y)),
            'Move'
          );
        }
        checkError(bindings.mouseDown!(args.button || 'left'), 'MouseDown');
        result = { success: true };
        break;
      case 'mouseUp':
        if (args.x !== undefined && args.y !== undefined) {
          checkError(
            bindings.move!(Math.trunc(args.x), Math.trunc(args.y)),
            'Move'
          );
        }
        checkError(bindings.mouseUp!(args.button || 'left'), 'MouseUp');
        result = { success: true };
        break;
      case 'keyDown':
        checkError(bindings.keyDown!(args.key), 'KeyDown');
        result = { success: true };
        break;
      case 'keyUp':
        checkError(bindings.keyUp!(args.key), 'KeyUp');
        result = { success: true };
        break;
      case 'drag': {
        const sx = Math.trunc(args.startX);
        const sy = Math.trunc(args.startY);
        const ex = Math.trunc(args.endX);
        const ey = Math.trunc(args.endY);
        checkError(bindings.move!(sx, sy), 'Move');
        checkError(bindings.mouseDown!(args.button || 'left'), 'MouseDown');
        checkError(
          bindings.moveSmooth!(ex, ey, 5, 10),
          `MoveSmooth(${ex}, ${ey})`
        );
        checkError(bindings.mouseUp!(args.button || 'left'), 'MouseUp');
        result = { success: true };
        break;
      }
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
