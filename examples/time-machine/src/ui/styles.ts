export function getStyles(): string {
  return `    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #e4e4e4;
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      margin-bottom: 30px;
    }

    h1 {
      font-size: 2.5rem;
      background: linear-gradient(90deg, #00d4ff, #7b2cbf, #ff006e);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 10px;
    }

    .subtitle {
      color: #888;
      font-size: 1.1rem;
    }

    .main-grid {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 20px;
    }

    @media (max-width: 900px) {
      .main-grid { grid-template-columns: 1fr; }
    }

    .panel {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      overflow: hidden;
    }

    .panel-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .panel-header h2 {
      font-size: 0.9rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #aaa;
    }

    .terminal {
      height: 400px;
      overflow-y: auto;
      padding: 16px;
      font-size: 14px;
      line-height: 1.6;
    }

    .terminal-line {
      margin-bottom: 4px;
    }

    .terminal-line.command {
      color: #00d4ff;
    }

    .terminal-line.command::before {
      content: '$ ';
      color: #7b2cbf;
    }

    .terminal-line.output {
      color: #e4e4e4;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .terminal-line.error {
      color: #ff006e;
    }

    .terminal-line.system {
      color: #00ff88;
      font-style: italic;
    }

    .input-area {
      display: flex;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(0, 0, 0, 0.3);
    }

    .input-area span {
      padding: 14px;
      color: #7b2cbf;
      font-weight: bold;
    }

    .input-area input {
      flex: 1;
      background: transparent;
      border: none;
      color: #00d4ff;
      font-family: inherit;
      font-size: 14px;
      padding: 14px 14px 14px 0;
      outline: none;
    }

    .input-area input::placeholder {
      color: #555;
    }

    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .actions {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 20px;
      border: none;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-save {
      background: linear-gradient(135deg, #00d4ff, #0099cc);
      color: #000;
    }

    .btn-save:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(0, 212, 255, 0.4);
    }

    .btn-danger {
      background: linear-gradient(135deg, #ff006e, #cc0055);
      color: #fff;
    }

    .btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(255, 0, 110, 0.4);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    .checkpoints-list {
      padding: 16px;
      max-height: 300px;
      overflow-y: auto;
    }

    .checkpoint-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .checkpoint-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .checkpoint-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #7b2cbf, #5a1a9a);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .checkpoint-info {
      flex: 1;
      min-width: 0;
    }

    .checkpoint-name {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .checkpoint-time {
      font-size: 11px;
      color: #666;
      margin-top: 2px;
    }

    .empty-state {
      text-align: center;
      padding: 30px;
      color: #555;
    }

    .empty-state-icon {
      font-size: 40px;
      margin-bottom: 10px;
    }

    .try-commands {
      padding: 16px;
    }

    .try-commands h3 {
      font-size: 12px;
      color: #666;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .command-chip {
      display: inline-block;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      font-size: 12px;
      margin: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .command-chip:hover {
      background: rgba(0, 212, 255, 0.2);
      border-color: rgba(0, 212, 255, 0.4);
    }

    .command-chip.danger {
      border-color: rgba(255, 0, 110, 0.3);
    }

    .command-chip.danger:hover {
      background: rgba(255, 0, 110, 0.2);
      border-color: rgba(255, 0, 110, 0.5);
    }

    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #222;
      padding: 14px 20px;
      border-radius: 8px;
      border-left: 4px solid #00d4ff;
      animation: slideIn 0.3s ease;
      z-index: 1000;
    }

    .toast.success { border-left-color: #00ff88; }
    .toast.error { border-left-color: #ff006e; }

    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
`;
}
