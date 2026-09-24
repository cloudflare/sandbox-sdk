// xterm.js draws the terminal and interprets escape sequences. It loads from a CDN to keep
// the example small; serve it with static assets in production.
export const terminalPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sandbox terminal</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css" />
    <style>
      html, body, #terminal { height: 100%; margin: 0; background: #000; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs";
      import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs";

      // tmux handles the mouse, so selecting text for the browser needs a modifier:
      // Shift, or Option on macOS.
      const terminal = new Terminal({ macOptionClickForcesSelection: true });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(document.getElementById("terminal"));
      fitAddon.fit();

      const session = new URLSearchParams(location.search).get("session") ?? "main";
      const encoder = new TextEncoder();
      const maxReconnectAttempts = 10;
      let socket;
      let reconnectAttempts = 0;

      const send = (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      };

      const connect = () => {
        const url = new URL("terminal", location.href);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("session", session);
        url.searchParams.set("cols", terminal.cols);
        url.searchParams.set("rows", terminal.rows);

        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          reconnectAttempts = 0;
          // tmux redraws the whole screen when a client attaches.
          terminal.reset();
        });
        socket.addEventListener("message", (event) => {
          terminal.write(new Uint8Array(event.data));
        });
        socket.addEventListener("close", (event) => {
          terminal.writeln("");
          // 1000 means the tmux client exited: the session ended or detached.
          if (event.code === 1000 || reconnectAttempts >= maxReconnectAttempts) {
            terminal.writeln("[" + (event.reason || "Disconnected") + "]");
            return;
          }
          const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
          reconnectAttempts++;
          terminal.writeln("[Reconnecting in " + delay / 1000 + " s]");
          setTimeout(connect, delay);
        });
      };
      connect();

      terminal.onData((data) => send(encoder.encode(data)));
      terminal.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })));
      addEventListener("resize", () => fitAddon.fit());
    </script>
  </body>
</html>`;
