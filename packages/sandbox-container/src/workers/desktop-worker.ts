// Runs in a dedicated child process (not a Worker thread).
// Owns all koffi bindings to desktop.so (robotgo).
// Operations are serialized: one at a time, in order.
// Communicates with the parent via newline-delimited JSON on stdin/stdout.

import type {
  DesktopWorkerOp,
  DesktopWorkerRequest,
  DesktopWorkerResponse,
  DesktopWorkerResultMap
} from '@repo/shared';

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

function reply(data: DesktopWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

type Handler<Op extends DesktopWorkerOp> = (
  msg: Extract<DesktopWorkerRequest, { op: Op }>
) => DesktopWorkerResultMap[Op];

const handlers: { [Op in DesktopWorkerOp]: Handler<Op> } = {
  screenshot: (msg) => {
    const sx = Math.max(0, msg.x);
    const sy = Math.max(0, msg.y);
    if (msg.w <= 0 || msg.h <= 0) {
      throw new Error(`Invalid screenshot dimensions: ${msg.w}x${msg.h}`);
    }
    checkError(
      bindings.screenshot!(msg.path, sx, sy, msg.w, msg.h),
      'Screenshot'
    );
    return { success: true, path: msg.path };
  },
  click: (msg) => {
    const btn = msg.button ?? 'left';
    const count = msg.clickCount ?? 1;
    checkError(bindings.move!(Math.trunc(msg.x), Math.trunc(msg.y)), 'Move');
    checkError(bindings.click!(btn, count), 'Click');
    return { success: true };
  },
  move: (msg) => {
    checkError(bindings.move!(Math.trunc(msg.x), Math.trunc(msg.y)), 'Move');
    return { success: true };
  },
  moveSmooth: (msg) => {
    const mx = Math.trunc(msg.x);
    const my = Math.trunc(msg.y);
    checkError(
      bindings.moveSmooth!(mx, my, msg.low ?? 5, msg.high ?? 10),
      `MoveSmooth(${mx}, ${my})`
    );
    return { success: true };
  },
  scroll: (msg) => {
    checkError(bindings.move!(Math.trunc(msg.x), Math.trunc(msg.y)), 'Move');
    checkError(bindings.scroll!(msg.scrollX ?? 0, msg.scrollY ?? 0), 'Scroll');
    return { success: true };
  },
  type: (msg) => {
    checkError(bindings.typeText!(msg.text, msg.pid ?? 0), 'TypeText');
    return { success: true };
  },
  keyTap: (msg) => {
    checkError(bindings.keyTap!(msg.key, msg.modifiers ?? ''), 'KeyTap');
    return { success: true };
  },
  getScreenSize: () => bindings.getScreenSize!(),
  getMousePos: () => bindings.getMousePos!(),
  mouseDown: (msg) => {
    if (msg.x !== undefined && msg.y !== undefined) {
      checkError(bindings.move!(Math.trunc(msg.x), Math.trunc(msg.y)), 'Move');
    }
    checkError(bindings.mouseDown!(msg.button ?? 'left'), 'MouseDown');
    return { success: true };
  },
  mouseUp: (msg) => {
    if (msg.x !== undefined && msg.y !== undefined) {
      checkError(bindings.move!(Math.trunc(msg.x), Math.trunc(msg.y)), 'Move');
    }
    checkError(bindings.mouseUp!(msg.button ?? 'left'), 'MouseUp');
    return { success: true };
  },
  keyDown: (msg) => {
    checkError(bindings.keyDown!(msg.key), 'KeyDown');
    return { success: true };
  },
  keyUp: (msg) => {
    checkError(bindings.keyUp!(msg.key), 'KeyUp');
    return { success: true };
  },
  drag: (msg) => {
    const sx = Math.trunc(msg.startX);
    const sy = Math.trunc(msg.startY);
    const ex = Math.trunc(msg.endX);
    const ey = Math.trunc(msg.endY);
    const btn = msg.button ?? 'left';
    checkError(bindings.move!(sx, sy), 'Move');
    checkError(bindings.mouseDown!(btn), 'MouseDown');
    checkError(bindings.moveSmooth!(ex, ey, 5, 10), `MoveSmooth(${ex}, ${ey})`);
    checkError(bindings.mouseUp!(btn), 'MouseUp');
    return { success: true };
  }
};

function handleMessage(msg: DesktopWorkerRequest): void {
  try {
    if (!lib && !loadLibrary()) {
      reply({
        id: msg.id,
        error: `Desktop library not available: ${loadError}`
      });
      return;
    }
    // Dispatch through the typed handler map. The cast narrows the handler
    // type to match the specific op, which the generic map cannot express.
    const handler = handlers[msg.op] as Handler<DesktopWorkerOp> | undefined;
    if (!handler) {
      reply({
        id: msg.id,
        error: `Unknown operation: ${(msg as { op: string }).op}`
      });
      return;
    }
    const result = handler(msg);
    reply({ id: msg.id, result });
  } catch (error) {
    reply({
      id: msg.id,
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
          handleMessage(JSON.parse(line) as DesktopWorkerRequest);
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
