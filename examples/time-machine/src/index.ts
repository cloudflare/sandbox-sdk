/**
 * Time Machine - Save checkpoints, run dangerous commands, travel back in time
 *
 * A visual demo of Sandbox SDK's snapshot/restore feature.
 * Create save points like in a video game, experiment freely, restore when needed.
 */

import { type DirectoryBackup, getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

/**
 * Checkpoint metadata displayed in the UI.
 */
interface Checkpoint {
  id: string;
  name: string;
  createdAt: string;
  dir: string;
}

/**
 * Metadata stored by the SDK in R2 at backups/{id}/meta.json
 */
interface BackupMetadata {
  id: string;
  dir: string;
  name: string | null;
  sizeBytes: number;
  ttl: number;
  createdAt: string;
}

// ─── API Handlers ──────────────────────────────────────────────────

async function handleExec(request: Request, env: Env): Promise<Response> {
  const { command } = await request.json<{ command: string }>();
  if (!command) {
    return Response.json({ error: 'Missing command' }, { status: 400 });
  }

  try {
    const sandbox = getSandbox(env.Sandbox, 'time-machine');
    const result = await sandbox.exec(command);

    return Response.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Command execution failed';
    return Response.json({
      stdout: '',
      stderr: message,
      exitCode: 1
    });
  }
}

async function handleSaveCheckpoint(
  request: Request,
  env: Env
): Promise<Response> {
  const { name } = await request.json<{ name?: string }>();
  const checkpointName = name || `checkpoint-${Date.now()}`;

  const sandbox = getSandbox(env.Sandbox, 'time-machine');

  // createBackup stores archive + meta.json in R2
  // The meta.json includes { id, dir, name, sizeBytes, ttl, createdAt }
  const backup = await sandbox.createBackup({
    dir: '/workspace',
    name: checkpointName,
    ttl: 24 * 60 * 60
  });

  // Return checkpoint info from the backup response
  const checkpoint: Checkpoint = {
    id: backup.id,
    name: checkpointName,
    createdAt: new Date().toISOString(),
    dir: backup.dir
  };

  return Response.json({ checkpoint });
}

async function handleRestore(request: Request, env: Env): Promise<Response> {
  const { id } = await request.json<{ id: string }>();
  if (!id) {
    return Response.json({ error: 'Missing checkpoint id' }, { status: 400 });
  }

  // Read metadata from R2 to get the dir
  const metaKey = `backups/${id}/meta.json`;
  const metaObj = await env.BACKUP_BUCKET.get(metaKey);
  if (!metaObj) {
    return Response.json({ error: 'Checkpoint not found' }, { status: 404 });
  }

  const meta = await metaObj.json<BackupMetadata>();
  const backup: DirectoryBackup = { id: meta.id, dir: meta.dir };

  const sandbox = getSandbox(env.Sandbox, 'time-machine');
  await sandbox.restoreBackup(backup);

  const checkpoint: Checkpoint = {
    id: meta.id,
    name: meta.name || `checkpoint-${meta.id.slice(0, 8)}`,
    createdAt: meta.createdAt,
    dir: meta.dir
  };

  return Response.json({ restored: checkpoint });
}

async function handleListCheckpoints(env: Env): Promise<Response> {
  // List all meta.json files in the backups/ prefix
  const listed = await env.BACKUP_BUCKET.list({ prefix: 'backups/' });

  // Filter to only meta.json files and fetch each
  const metaKeys = listed.objects
    .filter((obj) => obj.key.endsWith('/meta.json'))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime()) // newest first
    .slice(0, 20); // limit to 20

  const checkpoints: Checkpoint[] = [];
  for (const obj of metaKeys) {
    const metaObj = await env.BACKUP_BUCKET.get(obj.key);
    if (metaObj) {
      const meta = await metaObj.json<BackupMetadata>();
      checkpoints.push({
        id: meta.id,
        name: meta.name || `checkpoint-${meta.id.slice(0, 8)}`,
        createdAt: meta.createdAt,
        dir: meta.dir
      });
    }
  }

  return Response.json({ checkpoints });
}

// ─── HTML UI ───────────────────────────────────────────────────────

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Time Machine - Sandbox SDK Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
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
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Time Machine</h1>
      <p class="subtitle">Save checkpoints, experiment freely, travel back in time</p>
    </header>
    
    <div class="main-grid">
      <div class="panel">
        <div class="panel-header">
          <span>></span>
          <h2>Terminal</h2>
        </div>
        <div class="terminal" id="terminal">
          <div class="terminal-line system">Welcome to Time Machine! Try running some commands.</div>
          <div class="terminal-line system">Save a checkpoint before doing anything dangerous.</div>
        </div>
        <div class="input-area">
          <span>$</span>
          <input type="text" id="commandInput" placeholder="Type a command and press Enter..." autofocus>
        </div>
      </div>
      
      <div class="sidebar">
        <div class="panel">
          <div class="panel-header">
            <h2>Actions</h2>
          </div>
          <div class="actions">
            <button class="btn btn-save" id="saveBtn" onclick="saveCheckpoint()">
              <span>Save Checkpoint</span>
            </button>
            <button class="btn btn-danger" id="destroyBtn" onclick="runCommand('rm -rf /workspace/*')">
              <span>Destroy Everything</span>
            </button>
          </div>
        </div>
        
        <div class="panel">
          <div class="panel-header">
            <h2>Checkpoints</h2>
          </div>
          <div class="checkpoints-list" id="checkpointsList">
            <div class="empty-state">
              <div class="empty-state-icon">-</div>
              <div>No checkpoints yet</div>
            </div>
          </div>
        </div>
        
        <div class="panel">
          <div class="panel-header">
            <h2>Try These</h2>
          </div>
          <div class="try-commands">
            <h3>Safe Commands</h3>
            <span class="command-chip" onclick="runCommand('ls -la /workspace')">ls -la</span>
            <span class="command-chip" onclick="runCommand('echo \\'Hello!\\' > /workspace/hello.txt')">create file</span>
            <span class="command-chip" onclick="runCommand('cat /workspace/hello.txt')">read file</span>
            <span class="command-chip" onclick="runCommand('pwd')">pwd</span>
            
            <h3 style="margin-top: 16px;">Dangerous Commands</h3>
            <span class="command-chip danger" onclick="runCommand('rm -rf /workspace/*')">rm -rf /*</span>
            <span class="command-chip danger" onclick="runCommand('echo \\'corrupted\\' > /workspace/hello.txt')">corrupt file</span>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    const terminal = document.getElementById('terminal');
    const input = document.getElementById('commandInput');
    let isLoading = false;
    
    function addLine(text, className = 'output') {
      const line = document.createElement('div');
      line.className = 'terminal-line ' + className;
      line.textContent = text;
      terminal.appendChild(line);
      terminal.scrollTop = terminal.scrollHeight;
    }
    
    function showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    
    async function runCommand(command) {
      if (isLoading) return;
      isLoading = true;
      
      addLine(command, 'command');
      input.value = '';
      
      try {
        const res = await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command })
        });
        
        const data = await res.json();
        
        if (data.stdout) addLine(data.stdout);
        if (data.stderr) addLine(data.stderr, 'error');
        if (data.exitCode !== 0 && !data.stderr) {
          addLine('Exit code: ' + data.exitCode, 'error');
        }
      } catch (err) {
        addLine('Error: ' + err.message, 'error');
      }
      
      isLoading = false;
    }
    
    async function saveCheckpoint() {
      if (isLoading) return;
      isLoading = true;
      
      const saveBtn = document.getElementById('saveBtn');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="loading"></span> Saving...';
      
      try {
        const name = 'checkpoint-' + new Date().toLocaleTimeString();
        const res = await fetch('/api/checkpoint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        
        const data = await res.json();
        addLine('Checkpoint saved: ' + data.checkpoint.name, 'system');
        showToast('Checkpoint saved!', 'success');
        loadCheckpoints();
      } catch (err) {
        addLine('Failed to save checkpoint: ' + err.message, 'error');
        showToast('Failed to save checkpoint', 'error');
      }
      
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<span>Save Checkpoint</span>';
      isLoading = false;
    }
    
    async function restoreCheckpoint(id, name) {
      if (isLoading) return;
      if (!confirm('Restore to "' + name + '"? Current changes will be lost.')) return;
      
      isLoading = true;
      
      try {
        const res = await fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        
        const data = await res.json();
        addLine('Restored to: ' + data.restored.name, 'system');
        showToast('Restored successfully!', 'success');
      } catch (err) {
        addLine('Failed to restore: ' + err.message, 'error');
        showToast('Failed to restore', 'error');
      }
      
      isLoading = false;
    }
    
    async function loadCheckpoints() {
      try {
        const res = await fetch('/api/checkpoints');
        const data = await res.json();
        
        const list = document.getElementById('checkpointsList');
        
        if (data.checkpoints.length === 0) {
          list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">-</div><div>No checkpoints yet</div></div>';
          return;
        }
        
        list.innerHTML = data.checkpoints.map(cp => {
          const time = new Date(cp.createdAt).toLocaleTimeString();
          return \`
            <div class="checkpoint-item" onclick="restoreCheckpoint('\${cp.id}', '\${cp.name}')">
              <div class="checkpoint-icon">-</div>
              <div class="checkpoint-info">
                <div class="checkpoint-name">\${cp.name}</div>
                <div class="checkpoint-time">\${time}</div>
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Failed to load checkpoints:', err);
      }
    }
    
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        runCommand(input.value.trim());
      }
    });
    
    // Load checkpoints on start
    loadCheckpoints();
  </script>
</body>
</html>`;
}

// ─── Main Handler ──────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // API routes
      if (url.pathname === '/api/exec' && request.method === 'POST') {
        return handleExec(request, env);
      }

      if (url.pathname === '/api/checkpoint' && request.method === 'POST') {
        return handleSaveCheckpoint(request, env);
      }

      if (url.pathname === '/api/restore' && request.method === 'POST') {
        return handleRestore(request, env);
      }

      if (url.pathname === '/api/checkpoints' && request.method === 'GET') {
        return handleListCheckpoints(env);
      }

      // Serve UI
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return Response.json({ error: message }, { status: 500 });
    }
  }
};
