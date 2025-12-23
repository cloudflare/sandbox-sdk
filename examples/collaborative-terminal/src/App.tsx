import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';

// Custom terminal theme - inspired by modern terminals with Cloudflare orange accents
const terminalTheme = {
  // Base colors
  background: '#0c0c0c',
  foreground: '#d4d4d8',
  cursor: '#f97316',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#f9731640',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#f9731620',

  // Normal colors (ANSI 0-7)
  black: '#09090b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',

  // Bright colors (ANSI 8-15)
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
};

interface User {
  id: string;
  name: string;
  color: string;
}

interface AppState {
  connected: boolean;
  roomId: string | null;
  userId: string | null;
  userName: string | null;
  userColor: string | null;
  users: User[];
  hasActivePty: boolean;
  typingUser: User | null;
}

export function App() {
  const [state, setState] = useState<AppState>({
    connected: false,
    roomId: null,
    userId: null,
    userName: null,
    userColor: null,
    users: [],
    hasActivePty: false,
    typingUser: null
  });

  const [joinName, setJoinName] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize terminal when connected (terminal div becomes available)
  useEffect(() => {
    // Only initialize when connected and terminal div exists
    if (!state.connected || !terminalRef.current || xtermRef.current) return;

    console.log('[App] Initializing terminal...');
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      theme: terminalTheme,
      fontSize: 15,
      fontFamily:
        '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      lineHeight: 1.3,
      scrollback: 10000,
      convertEol: true
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    console.log(
      '[App] Terminal initialized, cols:',
      term.cols,
      'rows:',
      term.rows
    );

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'pty_resize',
            cols: term.cols,
            rows: term.rows
          })
        );
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [state.connected]);

  // Handle WebSocket messages
  const handleWsMessage = useCallback((event: MessageEvent) => {
    const message = JSON.parse(event.data);
    console.log('[App] WS message received:', message.type, message);
    const term = xtermRef.current;

    switch (message.type) {
      case 'connected':
        setState((s) => ({
          ...s,
          connected: true,
          userId: message.userId,
          userName: message.userName,
          userColor: message.userColor,
          users: message.users,
          hasActivePty: message.hasActivePty
        }));
        // Write history to terminal
        if (message.history && term) {
          term.write(message.history);
        }
        break;

      case 'user_joined':
        setState((s) => ({ ...s, users: message.users }));
        break;

      case 'user_left':
        setState((s) => ({ ...s, users: message.users }));
        break;

      case 'pty_started':
        // PTY started - output will come via WebSocket (pty_output messages)
        setState((s) => ({ ...s, hasActivePty: true }));
        console.log('[App] PTY started:', message.ptyId);
        break;

      case 'pty_output':
        // PTY output broadcast via WebSocket
        if (term) {
          term.write(message.data);
        }
        break;

      case 'pty_exit':
        setState((s) => ({ ...s, hasActivePty: false }));
        if (term) {
          term.writeln(`\r\n[Process exited with code ${message.exitCode}]`);
        }
        break;

      case 'user_typing':
        setState((s) => ({ ...s, typingUser: message.user }));
        // Clear typing indicator after 1 second
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }
        typingTimeoutRef.current = setTimeout(() => {
          setState((s) => ({ ...s, typingUser: null }));
        }, 1000);
        break;

      case 'error':
        console.error('Server error:', message.message);
        if (term) {
          term.writeln(`\r\n\x1b[31m[Error: ${message.message}]\x1b[0m`);
        }
        break;
    }
  }, []);

  // Connect to room
  const connectToRoom = useCallback(
    (roomId: string, userName: string) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws/room/${roomId}?name=${encodeURIComponent(userName)}`
      );

      ws.addEventListener('open', () => {
        wsRef.current = ws;
        setState((s) => ({ ...s, roomId }));
      });

      ws.addEventListener('message', handleWsMessage);

      ws.addEventListener('close', () => {
        wsRef.current = null;
        setState((s) => ({
          ...s,
          connected: false,
          roomId: null,
          users: [],
          hasActivePty: false
        }));
      });

      ws.addEventListener('error', (err) => {
        console.error('WebSocket error:', err);
      });
    },
    [handleWsMessage]
  );

  // Start PTY session
  const startPty = useCallback(() => {
    console.log(
      '[App] startPty called, ws state:',
      wsRef.current?.readyState,
      'term:',
      !!xtermRef.current
    );
    if (wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
      const msg = {
        type: 'start_pty',
        cols: xtermRef.current.cols,
        rows: xtermRef.current.rows
      };
      console.log('[App] Sending start_pty:', msg);
      wsRef.current.send(JSON.stringify(msg));
    } else {
      console.warn('[App] Cannot start PTY - ws not ready or no terminal');
    }
  }, []);

  // Handle terminal input
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const disposable = term.onData((data: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && state.hasActivePty) {
        wsRef.current.send(
          JSON.stringify({
            type: 'pty_input',
            data
          })
        );
      }
    });

    return () => disposable.dispose();
  }, [state.hasActivePty]);

  const generateRandomUserSuffix = () => {
    const array = new Uint32Array(1);
    window.crypto.getRandomValues(array);
    return array[0].toString(36).slice(0, 4);
  };

  // Create new room
  const createRoom = async () => {
    const name =
      joinName.trim() || `User-${generateRandomUserSuffix()}`;
    const response = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: name })
    });
    const data = (await response.json()) as { roomId: string };
    connectToRoom(data.roomId, name);
  };

  // Join existing room
  const joinRoom = () => {
    const name =
      joinName.trim() || `User-${generateRandomUserSuffix()}`;
    const roomId = joinRoomId.trim();
    if (roomId) {
      connectToRoom(roomId, name);
    }
  };

  // Copy room link
  const copyRoomLink = () => {
    const link = `${window.location.origin}?room=${state.roomId}`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Check for room in URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setJoinRoomId(roomFromUrl);
    }
  }, []);

  return (
    <div className="app">
      {/* Animated background gradient */}
      <div className="bg-gradient" />
      <div className="bg-grid" />

      {!state.connected ? (
        <div className="landing">
          <header className="landing-header">
            <div className="logo">
              <svg
                aria-hidden="true"
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span>Sandbox</span>
            </div>
          </header>

          <div className="hero">
            <div className="badge">
              <span className="badge-dot" />
              Powered by Cloudflare Sandboxes
            </div>
            <h1>
              Collaborative
              <br />
              <span className="gradient-text">Terminal</span>
            </h1>
            <p className="hero-subtitle">
              Real-time terminal sharing. Like Google Docs, but for your shell.
              <br />
              Code together, debug together, ship together.
            </p>

            <div className="join-card">
              <div className="input-group">
                <label htmlFor="name-input">Your name</label>
                <input
                  id="name-input"
                  type="text"
                  placeholder="Anonymous"
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  className="input"
                />
              </div>

              <button
                type="button"
                onClick={createRoom}
                className="btn btn-primary"
              >
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create New Room
              </button>

              <div className="divider">
                <span>or join existing</span>
              </div>

              <div className="join-row">
                <input
                  type="text"
                  placeholder="Enter room ID"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  className="input"
                />
                <button
                  type="button"
                  onClick={joinRoom}
                  className="btn btn-secondary"
                  disabled={!joinRoomId.trim()}
                >
                  Join
                </button>
              </div>
            </div>

            <div className="features">
              <div className="feature">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>Multi-user</span>
              </div>
              <div className="feature">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>Real-time sync</span>
              </div>
              <div className="feature">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Secure isolation</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="workspace">
          {/* Top bar */}
          <header className="workspace-header">
            <div className="header-left">
              <div className="logo logo-small">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </div>
              <div className="room-badge">
                <span className="room-label">Room</span>
                <code className="room-code">{state.roomId}</code>
                <button
                  type="button"
                  onClick={copyRoomLink}
                  className="copy-btn"
                  title="Copy invite link"
                >
                  {copied ? (
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div className="header-right">
              <div className="users-row">
                {state.users.map((user, idx) => (
                  <div
                    key={user.id}
                    className="user-avatar"
                    style={{
                      backgroundColor: user.color,
                      zIndex: state.users.length - idx
                    }}
                    title={`${user.name}${user.id === state.userId ? ' (you)' : ''}`}
                  >
                    {user.name.charAt(0).toUpperCase()}
                    {state.typingUser?.id === user.id && (
                      <span className="typing-dot" />
                    )}
                  </div>
                ))}
              </div>
              <div className="connection-status">
                <span className="status-dot" />
                <span className="status-text">{state.users.length} online</span>
              </div>
            </div>
          </header>

          {/* Terminal area */}
          <div className="terminal-area">
            {/* Floating clouds */}
            <div className="clouds">
              <div className="cloud cloud-1" />
              <div className="cloud cloud-2" />
              <div className="cloud cloud-3" />
              <div className="cloud cloud-4" />
              <div className="cloud cloud-5" />
            </div>
            <div className="terminal-window">
              {/* Window chrome */}
              <div className="window-chrome">
                <div className="traffic-lights">
                  <span className="light light-red" />
                  <span className="light light-yellow" />
                  <span className="light light-green" />
                </div>
                <div className="window-title">
                  {state.hasActivePty ? (
                    <>
                      <span className="shell-icon">$</span>
                      bash — {xtermRef.current?.cols}x{xtermRef.current?.rows}
                    </>
                  ) : (
                    'Terminal'
                  )}
                </div>
                <div className="window-actions">
                  {!state.hasActivePty && (
                    <button
                      type="button"
                      onClick={startPty}
                      className="start-btn"
                    >
                      <svg
                        aria-hidden="true"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Start Session
                    </button>
                  )}
                </div>
              </div>

              {/* Terminal content */}
              <div className="terminal-content">
                <div ref={terminalRef} className="terminal" />
                {!state.hasActivePty && (
                  <div className="terminal-placeholder">
                    <div className="placeholder-content">
                      <div className="placeholder-icon">
                        <svg
                          aria-hidden="true"
                          width="48"
                          height="48"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                      </div>
                      <h3>Ready to collaborate</h3>
                      <p>
                        Start a terminal session to begin. All participants will
                        see the same output in real-time.
                      </p>
                      <button
                        type="button"
                        onClick={startPty}
                        className="btn btn-primary btn-large"
                      >
                        <svg
                          aria-hidden="true"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        Start Terminal Session
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        .app {
          min-height: 100vh;
          background: #09090b;
          color: #fafafa;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          position: relative;
          overflow: hidden;
        }

        .bg-gradient {
          position: fixed;
          inset: 0;
          background:
            radial-gradient(ellipse 80% 50% at 50% -20%, rgba(249, 115, 22, 0.15), transparent),
            radial-gradient(ellipse 60% 40% at 100% 50%, rgba(249, 115, 22, 0.08), transparent),
            radial-gradient(ellipse 60% 40% at 0% 50%, rgba(59, 130, 246, 0.08), transparent);
          pointer-events: none;
        }

        .bg-grid {
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
          background-size: 64px 64px;
          pointer-events: none;
        }

        /* Landing page */
        .landing {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          position: relative;
          z-index: 1;
        }

        .landing-header {
          padding: 24px 32px;
        }

        .logo {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 600;
          font-size: 18px;
          color: #fafafa;
        }

        .logo svg {
          color: #f97316;
        }

        .logo-small {
          font-size: 0;
        }

        .hero {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 0 24px 80px;
          text-align: center;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          background: rgba(249, 115, 22, 0.1);
          border: 1px solid rgba(249, 115, 22, 0.2);
          border-radius: 100px;
          font-size: 13px;
          color: #fb923c;
          margin-bottom: 32px;
        }

        .badge-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .hero h1 {
          font-size: clamp(48px, 8vw, 80px);
          font-weight: 700;
          line-height: 1.1;
          letter-spacing: -0.02em;
          margin-bottom: 24px;
        }

        .gradient-text {
          background: linear-gradient(135deg, #f97316 0%, #fb923c 50%, #fbbf24 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .hero-subtitle {
          font-size: 18px;
          color: #a1a1aa;
          line-height: 1.6;
          max-width: 480px;
          margin-bottom: 48px;
        }

        .join-card {
          background: rgba(24, 24, 27, 0.8);
          border: 1px solid rgba(63, 63, 70, 0.5);
          border-radius: 16px;
          padding: 32px;
          width: 100%;
          max-width: 400px;
          backdrop-filter: blur(12px);
        }

        .input-group {
          margin-bottom: 20px;
        }

        .input-group label {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: #a1a1aa;
          margin-bottom: 8px;
        }

        .input {
          width: 100%;
          padding: 12px 16px;
          background: rgba(9, 9, 11, 0.8);
          border: 1px solid #27272a;
          border-radius: 10px;
          color: #fafafa;
          font-size: 15px;
          font-family: inherit;
          transition: all 0.2s;
        }

        .input::placeholder {
          color: #52525b;
        }

        .input:focus {
          outline: none;
          border-color: #f97316;
          box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.1);
        }

        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px 24px;
          border-radius: 10px;
          font-size: 15px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s;
          border: none;
        }

        .btn-primary {
          width: 100%;
          background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
          color: #fff;
          box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3);
        }

        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 20px rgba(249, 115, 22, 0.4);
        }

        .btn-secondary {
          background: #27272a;
          color: #fafafa;
          border: 1px solid #3f3f46;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #3f3f46;
        }

        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-large {
          padding: 16px 32px;
          font-size: 16px;
        }

        .divider {
          display: flex;
          align-items: center;
          gap: 16px;
          margin: 24px 0;
        }

        .divider::before,
        .divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: #27272a;
        }

        .divider span {
          font-size: 13px;
          color: #52525b;
        }

        .join-row {
          display: flex;
          gap: 12px;
        }

        .join-row .input {
          flex: 1;
        }

        .features {
          display: flex;
          gap: 32px;
          margin-top: 48px;
        }

        .feature {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          color: #71717a;
        }

        .feature svg {
          color: #52525b;
        }

        /* Workspace */
        .workspace {
          height: 100vh;
          display: flex;
          flex-direction: column;
          position: relative;
          z-index: 1;
        }

        .workspace-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 20px;
          background: rgba(9, 9, 11, 0.9);
          border-bottom: 1px solid #27272a;
          backdrop-filter: blur(12px);
        }

        .header-left,
        .header-right {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .room-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          background: #18181b;
          border: 1px solid #27272a;
          border-radius: 8px;
        }

        .room-label {
          font-size: 12px;
          color: #71717a;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .room-code {
          font-family: 'JetBrains Mono', 'SF Mono', monospace;
          font-size: 13px;
          color: #f97316;
          background: none;
        }

        .copy-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: #71717a;
          cursor: pointer;
          transition: all 0.2s;
        }

        .copy-btn:hover {
          background: #27272a;
          color: #fafafa;
        }

        .users-row {
          display: flex;
          margin-right: 8px;
        }

        .user-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 600;
          color: #fff;
          border: 2px solid #09090b;
          margin-left: -8px;
          position: relative;
          cursor: default;
          transition: transform 0.2s;
        }

        .user-avatar:first-child {
          margin-left: 0;
        }

        .user-avatar:hover {
          transform: scale(1.1);
          z-index: 100 !important;
        }

        .typing-dot {
          position: absolute;
          bottom: -2px;
          right: -2px;
          width: 10px;
          height: 10px;
          background: #22c55e;
          border: 2px solid #09090b;
          border-radius: 50%;
          animation: typing-pulse 1s infinite;
        }

        @keyframes typing-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.2); }
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          background: rgba(34, 197, 94, 0.1);
          border: 1px solid rgba(34, 197, 94, 0.2);
          border-radius: 100px;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
          box-shadow: 0 0 8px #22c55e;
        }

        .status-text {
          font-size: 12px;
          color: #4ade80;
        }

        /* Terminal area */
        .terminal-area {
          flex: 1;
          padding: 24px 40px 40px;
          display: flex;
          justify-content: center;
          align-items: flex-start;
          position: relative;
        }

        /* Floating clouds */
        .clouds {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 1;
        }

        .cloud {
          position: absolute;
          border-radius: 50%;
          filter: blur(40px);
          animation: float 20s ease-in-out infinite;
        }

        .cloud-1 {
          width: 400px;
          height: 250px;
          background: rgba(249, 115, 22, 0.7);
          bottom: 20px;
          left: 2%;
          animation-delay: 0s;
          animation-duration: 18s;
        }

        .cloud-2 {
          width: 350px;
          height: 220px;
          background: rgba(251, 146, 60, 0.6);
          bottom: 40px;
          right: 5%;
          animation-delay: -5s;
          animation-duration: 22s;
        }

        .cloud-3 {
          width: 500px;
          height: 300px;
          background: rgba(249, 115, 22, 0.5);
          bottom: 0px;
          left: 50%;
          transform: translateX(-50%);
          animation-delay: -10s;
          animation-duration: 25s;
        }

        .cloud-4 {
          width: 300px;
          height: 200px;
          background: rgba(234, 88, 12, 0.65);
          bottom: 60px;
          right: 25%;
          animation-delay: -7s;
          animation-duration: 20s;
        }

        .cloud-5 {
          width: 380px;
          height: 240px;
          background: rgba(251, 191, 36, 0.5);
          bottom: 30px;
          left: 20%;
          animation-delay: -15s;
          animation-duration: 28s;
        }

        @keyframes float {
          0%, 100% {
            transform: translateY(0) translateX(0) scale(1);
            opacity: 0.8;
          }
          25% {
            transform: translateY(-30px) translateX(15px) scale(1.1);
            opacity: 1;
          }
          50% {
            transform: translateY(-15px) translateX(-20px) scale(0.95);
            opacity: 0.7;
          }
          75% {
            transform: translateY(-40px) translateX(10px) scale(1.05);
            opacity: 0.9;
          }
        }

        .terminal-window {
          position: relative;
          z-index: 2;
          width: 100%;
          max-width: 1320px;
          height: 100%;
          max-height: 820px;
          display: flex;
          flex-direction: column;
          background: #0c0c0c;
          border: 1px solid #27272a;
          border-radius: 12px;
          overflow: hidden;
          box-shadow:
            0 0 0 1px rgba(255, 255, 255, 0.05),
            0 25px 60px rgba(0, 0, 0, 0.6),
            inset 0 1px 0 rgba(255, 255, 255, 0.05);
        }

        .window-chrome {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          background: #18181b;
          border-bottom: 1px solid #27272a;
          gap: 16px;
        }

        .traffic-lights {
          display: flex;
          gap: 8px;
        }

        .light {
          width: 12px;
          height: 12px;
          border-radius: 50%;
        }

        .light-red {
          background: #ef4444;
        }

        .light-yellow {
          background: #eab308;
        }

        .light-green {
          background: #22c55e;
        }

        .window-title {
          flex: 1;
          text-align: center;
          font-size: 13px;
          color: #71717a;
          font-family: 'SF Mono', monospace;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .shell-icon {
          color: #f97316;
          font-weight: 600;
        }

        .window-actions {
          min-width: 100px;
          display: flex;
          justify-content: flex-end;
        }

        .start-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
          border: none;
          border-radius: 6px;
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s;
        }

        .start-btn:hover {
          transform: scale(1.02);
          box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3);
        }

        .terminal-content {
          flex: 1;
          position: relative;
          overflow: hidden;
        }

        .terminal {
          height: 100%;
          padding: 12px 0;
        }

        .terminal-content:has(.terminal-placeholder) .terminal {
          pointer-events: none;
          opacity: 0;
        }

        .terminal-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(12, 12, 12, 0.98);
          z-index: 10;
        }

        .terminal-placeholder button {
          position: relative;
          z-index: 11;
          cursor: pointer;
        }

        .placeholder-content {
          text-align: center;
          max-width: 400px;
          padding: 40px;
        }

        .placeholder-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 80px;
          height: 80px;
          background: rgba(249, 115, 22, 0.1);
          border: 1px solid rgba(249, 115, 22, 0.2);
          border-radius: 20px;
          margin-bottom: 24px;
          color: #f97316;
        }

        .placeholder-content h3 {
          font-size: 20px;
          font-weight: 600;
          margin-bottom: 12px;
        }

        .placeholder-content p {
          font-size: 14px;
          color: #71717a;
          line-height: 1.6;
          margin-bottom: 24px;
        }

        /* Terminal customization */
        .terminal .xterm {
          padding: 0 16px;
        }

        .terminal .xterm-viewport {
          overflow-y: auto !important;
        }

        .terminal .xterm-viewport::-webkit-scrollbar {
          width: 8px;
        }

        .terminal .xterm-viewport::-webkit-scrollbar-track {
          background: transparent;
        }

        .terminal .xterm-viewport::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 4px;
        }

        .terminal .xterm-viewport::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }

        /* Responsive */
        @media (max-width: 768px) {
          .features {
            flex-direction: column;
            gap: 16px;
          }

          .hero h1 {
            font-size: 40px;
          }

          .workspace-header {
            flex-wrap: wrap;
            gap: 12px;
          }

          .header-right {
            width: 100%;
            justify-content: space-between;
          }
        }
      `}</style>
    </div>
  );
}
