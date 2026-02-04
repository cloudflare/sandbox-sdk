/**
 * R2 Snapshots Example - Brutalist UI Edition
 *
 * A minimalist 90s brutalist interface for testing directory snapshots with R2.
 */

import {
  getSandbox,
  Sandbox,
  type SnapshotR2Options
} from '@cloudflare/sandbox';
import { Hono } from 'hono';

export { Sandbox };

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

// Store snapshots and timing info in memory (per sandbox instance)
interface SandboxState {
  snapshots: Array<{
    id: string;
    createdAt: string;
    sizeBytes: number;
  }>;
  lastSetupTimeMs?: number;
  lastRestoreTimeMs?: number;
}

const sandboxStates = new Map<string, SandboxState>();

function getState(sandboxId: string): SandboxState {
  if (!sandboxStates.has(sandboxId)) {
    sandboxStates.set(sandboxId, { snapshots: [] });
  }
  return sandboxStates.get(sandboxId)!;
}

const app = new Hono<{ Bindings: Env }>();

function getR2Options(env: Env): SnapshotR2Options {
  return {
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY
    }
  };
}

// HTML UI with brutalist 90s theme
function renderUI(sandboxId: string, state: SandboxState, output?: string) {
  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  const hasSnapshot = !!lastSnapshot;

  const setupTime = state.lastSetupTimeMs
    ? `${(state.lastSetupTimeMs / 1000).toFixed(1)}s`
    : '---';
  const restoreTime = state.lastRestoreTimeMs
    ? `${(state.lastRestoreTimeMs / 1000).toFixed(1)}s`
    : '---';
  const speedup =
    state.lastSetupTimeMs && state.lastRestoreTimeMs
      ? `${(state.lastSetupTimeMs / state.lastRestoreTimeMs).toFixed(1)}x faster`
      : '---';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>R2 Snapshots // ${sandboxId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: "Courier New", monospace;
      background: #c0c0c0;
      color: #000;
      padding: 20px;
      min-height: 100vh;
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    
    h1 {
      background: linear-gradient(180deg, #000080 0%, #1084d0 100%);
      color: #fff;
      padding: 4px 8px;
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 2px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    h1 .close-btn {
      background: #c0c0c0;
      border: 2px outset #fff;
      width: 16px;
      height: 14px;
      font-size: 10px;
      line-height: 10px;
      text-align: center;
      cursor: pointer;
    }
    
    .window {
      border: 2px outset #fff;
      background: #c0c0c0;
      margin-bottom: 16px;
    }
    
    .window-content {
      padding: 12px;
      border: 2px inset #808080;
      margin: 2px;
    }
    
    .btn {
      background: #c0c0c0;
      border: 2px outset #fff;
      padding: 4px 12px;
      font-family: "Courier New", monospace;
      font-size: 12px;
      cursor: pointer;
      margin: 4px;
      min-width: 120px;
    }
    
    .btn:active {
      border: 2px inset #808080;
    }
    
    .btn:disabled {
      color: #808080;
      cursor: not-allowed;
    }
    
    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 8px 0;
    }
    
    .output-box {
      background: #000;
      color: #00ff00;
      font-family: "Courier New", monospace;
      font-size: 12px;
      padding: 12px;
      border: 2px inset #808080;
      min-height: 300px;
      max-height: 500px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    
    .status-bar {
      background: #c0c0c0;
      border: 2px inset #808080;
      padding: 4px 8px;
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      margin-top: 2px;
    }
    
    .timing-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin: 12px 0;
    }
    
    .timing-box {
      background: #fff;
      border: 2px inset #808080;
      padding: 8px;
      text-align: center;
    }
    
    .timing-label {
      font-size: 10px;
      color: #808080;
      text-transform: uppercase;
    }
    
    .timing-value {
      font-size: 18px;
      font-weight: bold;
      color: #000080;
    }
    
    .snapshot-list {
      max-height: 150px;
      overflow-y: auto;
      border: 2px inset #808080;
      background: #fff;
      padding: 4px;
      font-size: 11px;
    }
    
    .snapshot-item {
      padding: 2px 4px;
      border-bottom: 1px dotted #c0c0c0;
      display: flex;
      justify-content: space-between;
    }
    
    .snapshot-item:last-child {
      border-bottom: none;
    }
    
    .section-title {
      font-size: 12px;
      font-weight: bold;
      margin: 12px 0 6px 0;
      padding-bottom: 2px;
      border-bottom: 1px solid #808080;
    }
    
    .file-tree {
      background: #fff;
      border: 2px inset #808080;
      padding: 8px;
      font-size: 11px;
      max-height: 200px;
      overflow-y: auto;
    }
    
    .file-item {
      padding: 1px 0;
    }
    
    .file-item.dir { color: #000080; font-weight: bold; }
    .file-item.file { color: #000; }
    .file-item.symlink { color: #008080; }
    
    .loading {
      animation: blink 1s infinite;
    }
    
    @keyframes blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0.3; }
    }
    
    #output-area.loading::after {
      content: "\\n\\n>>> PROCESSING...";
      color: #ffff00;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="window">
      <h1>
        R2 Snapshots // sandbox: ${sandboxId}
        <span class="close-btn">X</span>
      </h1>
      <div class="window-content">
        
        <div class="section-title">// ACTIONS</div>
        <div class="btn-row">
          <button class="btn" onclick="runAction('start')">START</button>
          <button class="btn" onclick="runAction('setup')">SETUP (clone+npm)</button>
          <button class="btn" onclick="runAction('snapshot')">CREATE SNAPSHOT</button>
          <button class="btn" onclick="runAction('clear')">CLEAR DIR</button>
          <button class="btn" onclick="runAction('restore')" ${!hasSnapshot ? 'disabled' : ''}>
            RESTORE LAST
          </button>
        </div>
        
        <div class="btn-row">
          <button class="btn" onclick="runAction('ls', '/')">LS /</button>
          <button class="btn" onclick="runAction('ls', '/workspace')">LS /workspace</button>
          <button class="btn" onclick="runAction('ls', '/workspace/project')">LS /workspace/project</button>
          <button class="btn" onclick="runAction('exec', 'pwd && whoami')">EXEC: pwd</button>
        </div>
        
        <div class="section-title">// TIMING COMPARISON</div>
        <div class="timing-grid">
          <div class="timing-box">
            <div class="timing-label">Setup Time</div>
            <div class="timing-value">${setupTime}</div>
          </div>
          <div class="timing-box">
            <div class="timing-label">Restore Time</div>
            <div class="timing-value">${restoreTime}</div>
          </div>
          <div class="timing-box">
            <div class="timing-label">Speedup</div>
            <div class="timing-value">${speedup}</div>
          </div>
        </div>
        
        <div class="section-title">// SNAPSHOTS (${state.snapshots.length})</div>
        <div class="snapshot-list">
          ${
            state.snapshots.length === 0
              ? '<div style="color:#808080;padding:4px;">No snapshots yet</div>'
              : state.snapshots
                  .map(
                    (s, i) => `
              <div class="snapshot-item">
                <span>${i + 1}. ${s.id}</span>
                <span>${(s.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
              </div>
            `
                  )
                  .join('')
          }
        </div>
        
        <div class="section-title">// CONTAINER OUTPUT</div>
        <div id="output-area" class="output-box">${output || 'Ready. Click a button to begin.'}</div>
        
      </div>
      <div class="status-bar">
        <span>Sandbox: ${sandboxId}</span>
        <span>Snapshots: ${state.snapshots.length}</span>
        <span>${new Date().toISOString()}</span>
      </div>
    </div>
  </div>
  
  <script>
    const sandboxId = '${sandboxId}';
    const outputArea = document.getElementById('output-area');
    
    async function runAction(action, param) {
      outputArea.classList.add('loading');
      outputArea.textContent = '>>> Running ' + action + '...\\n';
      
      try {
        let url;
        switch(action) {
          case 'start':
            url = '/' + sandboxId + '/api/start';
            break;
          case 'setup':
            url = '/' + sandboxId + '/api/setup';
            break;
          case 'snapshot':
            url = '/' + sandboxId + '/api/snapshot';
            break;
          case 'clear':
            url = '/' + sandboxId + '/api/clear';
            break;
          case 'restore':
            url = '/' + sandboxId + '/api/restore';
            break;
          case 'ls':
            url = '/' + sandboxId + '/api/ls?path=' + encodeURIComponent(param);
            break;
          case 'exec':
            url = '/' + sandboxId + '/api/exec?cmd=' + encodeURIComponent(param);
            break;
          default:
            throw new Error('Unknown action: ' + action);
        }
        
        const resp = await fetch(url);
        const data = await resp.json();
        
        outputArea.classList.remove('loading');
        outputArea.textContent = formatOutput(action, data);
        
        // Refresh page after state-changing actions to update UI
        if (['setup', 'snapshot', 'clear', 'restore'].includes(action)) {
          setTimeout(() => location.reload(), 500);
        }
      } catch (err) {
        outputArea.classList.remove('loading');
        outputArea.textContent = '>>> ERROR: ' + err.message;
      }
    }
    
    function formatOutput(action, data) {
      let out = '>>> ' + action.toUpperCase() + ' completed\\n';
      out += '>>> Status: ' + (data.success ? 'SUCCESS' : 'FAILED') + '\\n';
      out += '----------------------------------------\\n';
      
      if (data.error) {
        out += 'ERROR: ' + data.error + '\\n';
      }
      
      if (data.output) {
        out += data.output + '\\n';
      }
      
      if (data.files) {
        out += 'Directory: ' + data.path + '\\n';
        out += 'Files: ' + data.files.length + '\\n';
        out += '----------------------------------------\\n';
        data.files.forEach(f => {
          const icon = f.type === 'directory' ? '[DIR]' : f.type === 'symlink' ? '[LNK]' : '[FILE]';
          const size = f.type === 'file' ? ' (' + formatSize(f.size) + ')' : '';
          out += icon + ' ' + f.name + size + '\\n';
        });
      }
      
      if (data.snapshot) {
        out += 'Snapshot ID: ' + data.snapshot.id + '\\n';
        out += 'Size: ' + formatSize(data.snapshot.sizeBytes) + '\\n';
      }
      
      if (data.timing) {
        out += '----------------------------------------\\n';
        out += 'Time: ' + (data.timing / 1000).toFixed(2) + 's\\n';
      }
      
      if (data.stdout) {
        out += data.stdout;
      }
      
      if (data.stderr && data.stderr.trim()) {
        out += '\\n[STDERR]\\n' + data.stderr;
      }
      
      return out;
    }
    
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }
  </script>
</body>
</html>`;
}

// Main UI route
app.get('/:id', async (c) => {
  const sandboxId = c.req.param('id');
  const state = getState(sandboxId);
  return c.html(renderUI(sandboxId, state));
});

// API: Start sandbox
app.get('/:id/api/start', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);

  const startTime = Date.now();
  const result = await sandbox.exec('echo "Container started" && uname -a');
  const timing = Date.now() - startTime;

  return c.json({
    success: result.success,
    output: result.stdout,
    timing
  });
});

// API: Setup (clone + npm install)
app.get('/:id/api/setup', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';

  const startTime = Date.now();

  // First clean up any existing directory
  await sandbox.exec(`rm -rf ${targetDir}`, { timeout: 30000 });

  // Clone a smaller repo (lodash is well-cached and smaller than axios)
  const cloneResult = await sandbox.exec(
    `git clone --depth 1 https://github.com/lodash/lodash.git ${targetDir}`,
    { timeout: 120000 }
  );

  if (!cloneResult.success) {
    return c.json({
      success: false,
      error: 'Git clone failed: ' + cloneResult.stderr
    });
  }

  // Run npm install with increased timeout
  const installResult = await sandbox.exec('npm install --prefer-offline', {
    cwd: targetDir,
    timeout: 300000
  });

  const timing = Date.now() - startTime;
  state.lastSetupTimeMs = timing;

  // Get directory size
  const sizeResult = await sandbox.exec(`du -sh ${targetDir}`, {
    timeout: 30000
  });

  return c.json({
    success: installResult.success,
    output: `Cloned lodash repository and ran npm install.\n\nDirectory size: ${sizeResult.stdout.trim()}`,
    timing,
    stdout: installResult.stdout.slice(-500),
    stderr: installResult.stderr.slice(-200)
  });
});

// API: Create snapshot
app.get('/:id/api/snapshot', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const directory = '/workspace/project';
  const r2Options = getR2Options(c.env);

  try {
    const startTime = Date.now();
    const result = await sandbox.snapshotDirectoryR2(directory, r2Options);
    const timing = Date.now() - startTime;

    // Store snapshot info
    state.snapshots.push({
      id: result.id,
      createdAt: result.createdAt,
      sizeBytes: result.sizeBytes
    });

    return c.json({
      success: true,
      output: `Snapshot created successfully!\n\nID: ${result.id}\nSize: ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB\nBucket: ${result.bucket}\nKey: ${result.key}`,
      snapshot: result,
      timing
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: Clear directory
app.get('/:id/api/clear', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const directory = '/workspace/project';

  // First check if directory exists
  const checkResult = await sandbox.exec(
    `test -d ${directory} && echo "exists" || echo "not_found"`
  );

  if (checkResult.stdout.trim() === 'not_found') {
    return c.json({
      success: true,
      output: `Directory ${directory} does not exist (already cleared)`
    });
  }

  // Get size before clearing
  const sizeResult = await sandbox.exec(`du -sh ${directory}`);
  const sizeBefore = sizeResult.stdout.trim();

  // Clear the directory
  const result = await sandbox.exec(`rm -rf ${directory}`);

  // Verify it's gone
  const verifyResult = await sandbox.exec(
    `test -d ${directory} && echo "still exists" || echo "cleared"`
  );
  const cleared = verifyResult.stdout.trim() === 'cleared';

  return c.json({
    success: cleared,
    output: cleared
      ? `Directory ${directory} cleared successfully.\n\nFreed: ${sizeBefore}`
      : `Failed to clear directory: ${result.stderr}`
  });
});

// API: Restore last snapshot
app.get('/:id/api/restore', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';
  const r2Options = getR2Options(c.env);

  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  if (!lastSnapshot) {
    return c.json({
      success: false,
      error: 'No snapshots available to restore'
    });
  }

  try {
    const startTime = Date.now();

    // Clear target directory first
    await sandbox.exec(`rm -rf ${targetDir}`, { timeout: 30000 });

    // Restore snapshot
    await sandbox.applyR2Snapshot(lastSnapshot.id, {
      ...r2Options,
      targetDirectory: targetDir
    });

    const timing = Date.now() - startTime;
    state.lastRestoreTimeMs = timing;

    // Verify restoration
    const verifyResult = await sandbox.exec(`ls ${targetDir} | wc -l`);
    const fileCount = verifyResult.stdout.trim();

    return c.json({
      success: true,
      output: `Snapshot restored successfully!\n\nSnapshot ID: ${lastSnapshot.id}\nTarget: ${targetDir}\nFiles restored: ${fileCount} items`,
      timing
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: List directory
app.get('/:id/api/ls', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const path = c.req.query('path') || '/';

  try {
    const files = await sandbox.listFiles(path);

    // Sort: directories first, then files, alphabetically
    const sorted = files.files.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({
      success: true,
      path,
      files: sorted.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size
      }))
    });
  } catch (error) {
    // Directory might not exist
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      success: false,
      path,
      error: `Cannot list ${path}: ${errorMsg}`,
      files: []
    });
  }
});

// API: Execute command
app.get('/:id/api/exec', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const cmd = c.req.query('cmd') || 'echo "No command provided"';

  const result = await sandbox.exec(cmd);

  return c.json({
    success: result.success,
    output: `$ ${cmd}\n\n${result.stdout}`,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode
  });
});

// API: Get info (snapshots list)
app.get('/:id/api/info', async (c) => {
  const sandboxId = c.req.param('id');
  const state = getState(sandboxId);

  return c.json({
    success: true,
    sandboxId,
    snapshots: state.snapshots,
    lastSetupTimeMs: state.lastSetupTimeMs,
    lastRestoreTimeMs: state.lastRestoreTimeMs
  });
});

// Root redirect
app.get('/', (c) => {
  return c.redirect('/demo');
});

export default app;
