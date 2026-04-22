// Runs in a dedicated child process (not a Worker thread).
// Owns all koffi bindings to desktop.so (robotgo).
// Operations are serialized: one at a time, in order.
// Communicates with the parent via newline-delimited JSON on stdin/stdout.

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

function reply(data: { id: string; result?: unknown; error?: string }): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function handleMessage(msg: {
  id: string;
  op: string;
  [key: string]: unknown;
}): void {
  const { id, op, ...args } = msg;

  try {
    if (!lib && !loadLibrary()) {
      reply({ id, error: `Desktop library not available: ${loadError}` });
      return;
    }

    let result: unknown;
    switch (op) {
      case 'screenshot': {
        const sx = Math.max(0, (args.x as number) ?? 0);
        const sy = Math.max(0, (args.y as number) ?? 0);
        const sw = (args.w as number) ?? 0;
        const sh = (args.h as number) ?? 0;
        if (sw <= 0 || sh <= 0) {
          throw new Error(`Invalid screenshot dimensions: ${sw}x${sh}`);
        }
        checkError(
          bindings.screenshot!(args.path as string, sx, sy, sw, sh),
          'Screenshot'
        );
        result = { success: true, path: args.path };
        break;
      }
      case 'click': {
        const btn = (args.button as string) || 'left';
        const count = (args.clickCount as number) ?? 1;
        checkError(
          bindings.move!(
            Math.trunc(args.x as number),
            Math.trunc(args.y as number)
          ),
          'Move'
        );
        checkError(bindings.click!(btn, count), 'Click');
        result = { success: true };
        break;
      }
      case 'move':
        checkError(
          bindings.move!(
            Math.trunc(args.x as number),
            Math.trunc(args.y as number)
          ),
          'Move'
        );
        result = { success: true };
        break;
      case 'moveSmooth': {
        const mx = Math.trunc(args.x as number);
        const my = Math.trunc(args.y as number);
        checkError(
          bindings.moveSmooth!(
            mx,
            my,
            (args.low as number) ?? 5,
            (args.high as number) ?? 10
          ),
          `MoveSmooth(${mx}, ${my})`
        );
        result = { success: true };
        break;
      }
      case 'scroll':
        checkError(
          bindings.move!(
            Math.trunc(args.x as number),
            Math.trunc(args.y as number)
          ),
          'Move'
        );
        checkError(
          bindings.scroll!(
            (args.scrollX as number) ?? 0,
            (args.scrollY as number) ?? 0
          ),
          'Scroll'
        );
        result = { success: true };
        break;
      case 'type':
        checkError(
          bindings.typeText!(args.text as string, (args.pid as number) ?? 0),
          'TypeText'
        );
        result = { success: true };
        break;
      case 'keyTap':
        checkError(
          bindings.keyTap!(
            args.key as string,
            (args.modifiers as string) ?? ''
          ),
          'KeyTap'
        );
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
            bindings.move!(
              Math.trunc(args.x as number),
              Math.trunc(args.y as number)
            ),
            'Move'
          );
        }
        checkError(
          bindings.mouseDown!((args.button as string) || 'left'),
          'MouseDown'
        );
        result = { success: true };
        break;
      case 'mouseUp':
        if (args.x !== undefined && args.y !== undefined) {
          checkError(
            bindings.move!(
              Math.trunc(args.x as number),
              Math.trunc(args.y as number)
            ),
            'Move'
          );
        }
        checkError(
          bindings.mouseUp!((args.button as string) || 'left'),
          'MouseUp'
        );
        result = { success: true };
        break;
      case 'keyDown':
        checkError(bindings.keyDown!(args.key as string), 'KeyDown');
        result = { success: true };
        break;
      case 'keyUp':
        checkError(bindings.keyUp!(args.key as string), 'KeyUp');
        result = { success: true };
        break;
      case 'drag': {
        const sx = Math.trunc(args.startX as number);
        const sy = Math.trunc(args.startY as number);
        const ex = Math.trunc(args.endX as number);
        const ey = Math.trunc(args.endY as number);
        checkError(bindings.move!(sx, sy), 'Move');
        checkError(
          bindings.mouseDown!((args.button as string) || 'left'),
          'MouseDown'
        );
        checkError(
          bindings.moveSmooth!(ex, ey, 5, 10),
          `MoveSmooth(${ex}, ${ey})`
        );
        checkError(
          bindings.mouseUp!((args.button as string) || 'left'),
          'MouseUp'
        );
        result = { success: true };
        break;
      }
      default:
        reply({ id, error: `Unknown operation: ${op}` });
        return;
    }
    reply({ id, result });
  } catch (error) {
    reply({
      id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Read newline-delimited JSON from stdin
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = '';

(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      let idx: number = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          // Malformed input — skip
        }
        idx = buffer.indexOf('\n');
      }
    }
  } catch {
    // stdin closed
  }
  process.exit(0);
})();
