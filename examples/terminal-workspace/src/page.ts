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

      const terminal = new Terminal();
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(document.getElementById("terminal"));
      fitAddon.fit();

      const url = new URL("terminal", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("cols", terminal.cols);
      url.searchParams.set("rows", terminal.rows);

      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      const encoder = new TextEncoder();
      const send = (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      };

      socket.addEventListener("message", (event) => {
        terminal.write(new Uint8Array(event.data));
      });
      socket.addEventListener("close", (event) => {
        terminal.writeln("");
        terminal.writeln("[" + (event.reason || "Disconnected") + "]");
      });

      terminal.onData((data) => send(encoder.encode(data)));
      terminal.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })));
      addEventListener("resize", () => fitAddon.fit());
    </script>
  </body>
</html>`;
