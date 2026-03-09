import { type ConnectionState, SandboxAddon } from '@cloudflare/sandbox/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  sandboxId: string;
  sessionId: string;
  onTyping?: () => void;
  onAddonReady?: (addon: SandboxAddon) => void;
}

export function Terminal({
  sandboxId,
  sessionId,
  onTyping,
  onAddonReady
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnectionState>('disconnected');

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once — parent controls session switching via addon ref
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: '#09090b',
        foreground: '#fafafa',
        cursor: '#f97316',
        cursorAccent: '#09090b',
        selectionBackground: '#f9731640',
        black: '#09090b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#fafafa',
        brightBlack: '#71717a',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff'
      }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: ({ origin, sessionId: sid }) =>
        `${origin}/ws/terminal/${sid}`,
      onStateChange: (newState) => setState(newState)
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(sandboxAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminal.onData(() => onTyping?.());
    sandboxAddon.connect({ sandboxId, sessionId });
    onAddonReady?.(sandboxAddon);

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
    };
  }, []);

  return (
    <div className="relative h-full">
      <div ref={containerRef} className="h-full w-full" />
      {state !== 'connected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80">
          <div className="flex items-center gap-3 text-zinc-400">
            {state === 'connecting' ? (
              <>
                <Spinner />
                <span>Connecting to terminal...</span>
              </>
            ) : (
              <span>Disconnected</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="w-5 h-5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}
