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

// Popular JS repos for the dropdown
const POPULAR_REPOS = [
  {
    name: 'lodash',
    url: 'https://github.com/lodash/lodash.git',
    description: 'Utility library'
  },
  {
    name: 'axios',
    url: 'https://github.com/axios/axios.git',
    description: 'HTTP client'
  },
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    description: 'Web framework'
  },
  {
    name: 'chalk',
    url: 'https://github.com/chalk/chalk.git',
    description: 'Terminal styling'
  },
  {
    name: 'dayjs',
    url: 'https://github.com/iamkun/dayjs.git',
    description: 'Date library'
  },
  {
    name: 'uuid',
    url: 'https://github.com/uuidjs/uuid.git',
    description: 'UUID generator'
  }
];

// Store snapshots and timing info in memory (per sandbox instance)
interface SandboxState {
  snapshots: Array<{
    id: string;
    createdAt: string;
    sizeBytes: number;
  }>;
  lastSetupTimeMs?: number;
  lastRestoreTimeMs?: number;
  lastStartTimeMs?: number;
  selectedRepo?: string;
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

  const startTime = state.lastStartTimeMs
    ? `${(state.lastStartTimeMs / 1000).toFixed(1)}s`
    : '---';
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

  // Build repo dropdown options
  const repoOptions = POPULAR_REPOS.map(
    (r) =>
      `<option value="${r.name}" ${state.selectedRepo === r.name ? 'selected' : ''}>${r.name} - ${r.description}</option>`
  ).join('\n');

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
          <select id="repo-select" class="btn" style="min-width: 180px;">
            ${repoOptions}
          </select>
          <button class="btn" onclick="runAction('setup', document.getElementById('repo-select').value)">SETUP (clone+npm)</button>
          <button class="btn" onclick="runAction('snapshot')">CREATE SNAPSHOT</button>
        </div>
        
        <div class="btn-row">
          <button class="btn" onclick="runAction('clear')">CLEAR DIR</button>
          <button class="btn" onclick="runAction('restore')" ${!hasSnapshot ? 'disabled' : ''}>
            RESTORE LAST
          </button>
          <button class="btn" onclick="runAction('ls', '/workspace/project')">LS PROJECT</button>
          <button class="btn" onclick="runAction('sleep')" style="background: #ff9999;">SLEEP CONTAINER</button>
        </div>
        
        <div class="section-title">// TIMING COMPARISON</div>
        <div class="timing-grid" style="grid-template-columns: repeat(4, 1fr);">
          <div class="timing-box">
            <div class="timing-label">Container Start</div>
            <div class="timing-value">${startTime}</div>
          </div>
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
            url = '/' + sandboxId + '/api/setup?repo=' + encodeURIComponent(param || 'lodash');
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
          case 'sleep':
            url = '/' + sandboxId + '/api/sleep';
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
        if (['setup', 'snapshot', 'clear', 'restore', 'start', 'sleep'].includes(action)) {
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

// API: Start sandbox (measures cold start time)
app.get('/:id/api/start', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);

  const startTime = Date.now();
  const result = await sandbox.exec('echo "Container started" && uname -a');
  const timing = Date.now() - startTime;

  // Track cold start time
  state.lastStartTimeMs = timing;

  return c.json({
    success: result.success,
    output: `Container started in ${(timing / 1000).toFixed(2)}s\n\n${result.stdout}`,
    timing
  });
});

// API: Sleep (destroy) sandbox
app.get('/:id/api/sleep', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);

  try {
    await sandbox.destroy();
    return c.json({
      success: true,
      output: 'Container sent to sleep. It will restart on next request.'
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: Setup (clone + npm install)
app.get('/:id/api/setup', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';

  // Get repo from query param, default to lodash
  const repoName = c.req.query('repo') || 'lodash';
  const repo =
    POPULAR_REPOS.find((r) => r.name === repoName) || POPULAR_REPOS[0];
  state.selectedRepo = repo.name;

  const startTime = Date.now();

  // First clean up any existing directory
  await sandbox.exec(`rm -rf ${targetDir}`, { timeout: 30000 });

  // Clone the selected repo
  const cloneResult = await sandbox.exec(
    `git clone --depth 1 ${repo.url} ${targetDir}`,
    { timeout: 120000 }
  );

  if (!cloneResult.success) {
    return c.json({
      success: false,
      error: `Git clone failed for ${repo.name}: ${cloneResult.stderr}`
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
    output: `Cloned ${repo.name} (${repo.description}) and ran npm install.\n\nDirectory size: ${sizeResult.stdout.trim()}`,
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

    // Restore snapshot - the service handles clearing the target directory
    // internally using atomic temp-dir + rename for better performance
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

// API: Benchmark restore (detailed timing)
app.get('/:id/api/benchmark', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';
  const r2Options = getR2Options(c.env);

  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  if (!lastSnapshot) {
    return c.json({
      success: false,
      error: 'No snapshots available'
    });
  }

  const timings: Record<string, number> = {};
  let start: number;

  try {
    // Restore snapshot - the snapshot service handles clearing the target directory
    // internally using an atomic temp-dir + rename approach for better performance
    start = Date.now();
    await sandbox.applyR2Snapshot(lastSnapshot.id, {
      ...r2Options,
      targetDirectory: targetDir
    });
    timings.restore = Date.now() - start;

    // 3. Verify (skip for benchmarking to avoid overhead)
    // timings.verify = 0;

    state.lastRestoreTimeMs = timings.restore;

    return c.json({
      success: true,
      snapshotId: lastSnapshot.id,
      snapshotSizeBytes: lastSnapshot.sizeBytes,
      timings,
      totalMs: timings.restore,
      analysis: {
        restoreMs: timings.restore,
        note: 'restore includes: presigned URL generation, download, decompress, extract, atomic replace'
      }
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: Direct restore using exec (bypasses SDK snapshot API)
app.get('/:id/api/restore-direct', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';
  const r2Options = getR2Options(c.env);

  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  if (!lastSnapshot) {
    return c.json({
      success: false,
      error: 'No snapshots available'
    });
  }

  const timings: Record<string, number> = {};
  let start: number;

  try {
    // Generate presigned URL using AWS SDK
    start = Date.now();
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Options.endpoint,
      credentials: {
        accessKeyId: r2Options.credentials.accessKeyId,
        secretAccessKey: r2Options.credentials.secretAccessKey
      }
    });

    const presignedGetUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: r2Options.bucket,
        Key: `snapshots/${lastSnapshot.id}.tar.zst`
      }),
      { expiresIn: 3600 }
    );
    timings.presign = Date.now() - start;

    // Clear directory
    start = Date.now();
    await sandbox.exec(`rm -rf ${targetDir}`, { timeout: 30000 });
    timings.clear = Date.now() - start;

    // Create target directory
    start = Date.now();
    await sandbox.exec(`mkdir -p ${targetDir}`, { timeout: 5000 });
    timings.mkdir = Date.now() - start;

    // Download to temp file
    start = Date.now();
    const downloadResult = await sandbox.exec(
      `curl -sf -o /tmp/snapshot.tar.zst '${presignedGetUrl}'`,
      { timeout: 120000 }
    );
    timings.download = Date.now() - start;

    if (!downloadResult.success) {
      return c.json({
        success: false,
        error: `Download failed: ${downloadResult.stderr}`,
        timings
      });
    }

    // Extract - use time command to see actual wall clock time
    start = Date.now();
    const extractResult = await sandbox.exec(
      `time (zstd -d -T0 < /tmp/snapshot.tar.zst | tar -xf - -C ${targetDir} --no-same-owner --no-same-permissions) 2>&1 && rm -f /tmp/snapshot.tar.zst`,
      { timeout: 120000 }
    );
    timings.extract = Date.now() - start;
    const extractShellTime = extractResult.stdout || extractResult.stderr;

    if (!extractResult.success) {
      return c.json({
        success: false,
        error: `Extract failed: ${extractResult.stderr}`,
        timings
      });
    }

    const totalMs =
      timings.presign +
      timings.clear +
      timings.mkdir +
      timings.download +
      timings.extract;
    state.lastRestoreTimeMs = totalMs;

    return c.json({
      success: true,
      snapshotId: lastSnapshot.id,
      timings,
      totalMs,
      extractShellTime,
      analysis: {
        presignMs: timings.presign,
        clearMs: timings.clear,
        mkdirMs: timings.mkdir,
        downloadMs: timings.download,
        extractMs: timings.extract
      }
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg, timings });
  }
});

// API: Single-exec restore (all in one shell command)
app.get('/:id/api/restore-single', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const targetDir = '/workspace/project';
  const r2Options = getR2Options(c.env);

  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  if (!lastSnapshot) {
    return c.json({
      success: false,
      error: 'No snapshots available'
    });
  }

  try {
    // Generate presigned URL
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Options.endpoint,
      credentials: {
        accessKeyId: r2Options.credentials.accessKeyId,
        secretAccessKey: r2Options.credentials.secretAccessKey
      }
    });

    const presignedGetUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: r2Options.bucket,
        Key: `snapshots/${lastSnapshot.id}.tar.zst`
      }),
      { expiresIn: 3600 }
    );

    // Do EVERYTHING in one exec call
    const start = Date.now();
    const result = await sandbox.exec(
      `rm -rf ${targetDir} && mkdir -p ${targetDir} && time (curl -sf '${presignedGetUrl}' | zstd -d -T0 | tar -xf - -C ${targetDir} --no-same-owner --no-same-permissions) 2>&1`,
      { timeout: 180000 }
    );
    const totalMs = Date.now() - start;

    state.lastRestoreTimeMs = totalMs;

    return c.json({
      success: result.success,
      snapshotId: lastSnapshot.id,
      totalMs,
      shellOutput: result.stdout || result.stderr,
      exitCode: result.exitCode
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: Diagnostic - compare extract to /tmp vs /workspace
// This test downloads the file first, then tests extraction to both locations
// with the file already cached in memory for a fair comparison
app.get('/:id/api/diagnostic', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const state = getState(sandboxId);
  const r2Options = getR2Options(c.env);

  const lastSnapshot = state.snapshots[state.snapshots.length - 1];
  if (!lastSnapshot) {
    return c.json({
      success: false,
      error: 'No snapshots available'
    });
  }

  try {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Options.endpoint,
      credentials: {
        accessKeyId: r2Options.credentials.accessKeyId,
        secretAccessKey: r2Options.credentials.secretAccessKey
      }
    });

    const presignedGetUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: r2Options.bucket,
        Key: `snapshots/${lastSnapshot.id}.tar.zst`
      }),
      { expiresIn: 3600 }
    );

    const results: Record<string, unknown> = {};

    // Download file first to ensure fair comparison
    const downloadResult = await sandbox.exec(
      `curl -sf '${presignedGetUrl}' -o /tmp/snap.tar.zst && ls -l /tmp/snap.tar.zst`,
      { timeout: 120000 }
    );
    results.download = downloadResult.stdout;

    // Sync and drop caches for fair comparison
    await sandbox.exec(
      'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true',
      { timeout: 30000 }
    );

    // Test 1: Extract to fresh /tmp directory
    const tmpDir = `/tmp/diag-${Date.now()}`;
    const tmpResult = await sandbox.exec(
      `mkdir -p ${tmpDir} && time (zstd -d -T0 < /tmp/snap.tar.zst | tar -xf - -C ${tmpDir} --no-same-owner --no-same-permissions) 2>&1`,
      { timeout: 180000 }
    );
    results.test1_tmp = {
      target: tmpDir,
      success: tmpResult.success,
      time: tmpResult.stdout || tmpResult.stderr
    };

    // Sync and drop caches again
    await sandbox.exec(
      'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true',
      { timeout: 30000 }
    );

    // Test 2: Extract to /workspace after rm -rf (reusing same space)
    const wsDir = '/workspace/diag-test';
    await sandbox.exec(`rm -rf ${wsDir} && mkdir -p ${wsDir}`, {
      timeout: 30000
    });
    const wsResult = await sandbox.exec(
      `time (zstd -d -T0 < /tmp/snap.tar.zst | tar -xf - -C ${wsDir} --no-same-owner --no-same-permissions) 2>&1`,
      { timeout: 180000 }
    );
    results.test2_workspace_after_rm = {
      target: wsDir,
      success: wsResult.success,
      time: wsResult.stdout || wsResult.stderr
    };

    // Sync and drop caches again
    await sandbox.exec(
      'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true',
      { timeout: 30000 }
    );

    // Test 3: Extract to /workspace AGAIN (same location, second time)
    await sandbox.exec(`rm -rf ${wsDir} && mkdir -p ${wsDir}`, {
      timeout: 30000
    });
    const ws2Result = await sandbox.exec(
      `time (zstd -d -T0 < /tmp/snap.tar.zst | tar -xf - -C ${wsDir} --no-same-owner --no-same-permissions) 2>&1`,
      { timeout: 180000 }
    );
    results.test3_workspace_second_time = {
      target: wsDir,
      success: ws2Result.success,
      time: ws2Result.stdout || ws2Result.stderr
    };

    // Clean up
    await sandbox.exec(`rm -rf ${tmpDir} ${wsDir} /tmp/snap.tar.zst`, {
      timeout: 30000
    });

    return c.json({
      success: true,
      snapshotId: lastSnapshot.id,
      results
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: Full squashfs snapshot + restore benchmark
app.get('/:id/api/squashfs-benchmark', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);
  const r2Options = getR2Options(c.env);

  try {
    // Check tools
    const checkTools = await sandbox.exec('which mksquashfs squashfuse', {
      timeout: 5000
    });
    if (!checkTools.success) {
      return c.json({
        success: false,
        error: 'squashfs tools not installed'
      });
    }

    const { S3Client, PutObjectCommand, GetObjectCommand } =
      await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

    const s3Client = new S3Client({
      region: 'auto',
      endpoint: r2Options.endpoint,
      credentials: {
        accessKeyId: r2Options.credentials.accessKeyId,
        secretAccessKey: r2Options.credentials.secretAccessKey
      }
    });

    const timings: Record<string, number> = {};
    const snapshotKey = `snapshots/squashfs-test-${Date.now()}.sqsh`;

    // Step 1: Create squashfs
    let start = Date.now();
    await sandbox.exec(
      'rm -f /tmp/upload.sqsh && mksquashfs /workspace/project /tmp/upload.sqsh -comp zstd -Xcompression-level 3 -no-progress -quiet',
      { timeout: 120000 }
    );
    timings.createSquashfs = Date.now() - start;

    // Step 2: Upload to R2
    start = Date.now();
    const uploadUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: r2Options.bucket,
        Key: snapshotKey
      }),
      { expiresIn: 3600 }
    );
    await sandbox.exec(`curl -sf -X PUT -T /tmp/upload.sqsh '${uploadUrl}'`, {
      timeout: 120000
    });
    timings.upload = Date.now() - start;

    // Step 3: Simulate restore - download + mount (run 5 times)
    const downloadUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: r2Options.bucket,
        Key: snapshotKey
      }),
      { expiresIn: 3600 }
    );

    const restoreTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      // Unmount if mounted
      await sandbox.exec('fusermount -u /mnt/project 2>/dev/null || true', {
        timeout: 5000
      });
      await sandbox.exec('rm -f /tmp/restore.sqsh', { timeout: 5000 });

      start = Date.now();
      // Download
      await sandbox.exec(
        `curl -sf -o /tmp/restore.sqsh '${downloadUrl}' && mkdir -p /mnt/project && squashfuse /tmp/restore.sqsh /mnt/project`,
        { timeout: 120000 }
      );
      restoreTimes.push(Date.now() - start);
    }
    timings.avgRestore = Math.round(
      restoreTimes.reduce((a, b) => a + b, 0) / restoreTimes.length
    );

    // Verify
    const verifyResult = await sandbox.exec(
      'ls /mnt/project/node_modules | wc -l',
      { timeout: 10000 }
    );

    // Cleanup
    await sandbox.exec('fusermount -u /mnt/project 2>/dev/null || true', {
      timeout: 5000
    });

    return c.json({
      success: true,
      timings,
      restoreTimes,
      verification: {
        nodeModulesCount: verifyResult.stdout?.trim()
      },
      comparison: {
        tarExtract: '25000-50000ms (degrades over time)',
        squashfsMount: `${timings.avgRestore}ms (consistent)`,
        speedup: `${Math.round(37500 / timings.avgRestore)}x faster`
      }
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// API: SquashFS benchmark - test squashfs create/mount vs tar extract
app.get('/:id/api/squashfs-test', async (c) => {
  const sandboxId = c.req.param('id');
  const sandbox = getSandbox(c.env.Sandbox, sandboxId);

  const results: Record<string, unknown> = {};

  try {
    // Ensure squashfs tools are installed
    const checkTools = await sandbox.exec('which mksquashfs squashfuse', {
      timeout: 5000
    });
    if (!checkTools.success) {
      return c.json({
        success: false,
        error:
          'squashfs tools not installed. Run: apt-get install -y squashfs-tools squashfuse fuse'
      });
    }

    // Check if project exists
    const checkProject = await sandbox.exec(
      'test -d /workspace/project && echo exists',
      { timeout: 5000 }
    );
    if (!checkProject.stdout?.includes('exists')) {
      return c.json({
        success: false,
        error: 'No project at /workspace/project. Run setup first.'
      });
    }

    // Test 1: Create squashfs image
    const createStart = Date.now();
    const createResult = await sandbox.exec(
      'rm -f /tmp/test.sqsh && mksquashfs /workspace/project /tmp/test.sqsh -comp zstd -Xcompression-level 3 -no-progress -quiet 2>&1',
      { timeout: 120000 }
    );
    results.createSquashfs = {
      success: createResult.success,
      timeMs: Date.now() - createStart,
      output: createResult.stdout || createResult.stderr
    };

    // Get file size
    const sizeResult = await sandbox.exec('ls -l /tmp/test.sqsh', {
      timeout: 5000
    });
    results.squashfsSize = sizeResult.stdout;

    // Test 2: Mount squashfs (simulating restore)
    // First unmount if already mounted
    await sandbox.exec('fusermount -u /mnt/sqsh-test 2>/dev/null || true', {
      timeout: 5000
    });
    await sandbox.exec('mkdir -p /mnt/sqsh-test', { timeout: 5000 });

    const mountStart = Date.now();
    const mountResult = await sandbox.exec(
      'squashfuse /tmp/test.sqsh /mnt/sqsh-test 2>&1',
      { timeout: 30000 }
    );
    const mountTime = Date.now() - mountStart;
    results.mountSquashfs = {
      success: mountResult.success,
      timeMs: mountTime,
      output: mountResult.stdout || mountResult.stderr
    };

    // Verify mount works
    const verifyResult = await sandbox.exec(
      'ls /mnt/sqsh-test/node_modules | wc -l',
      { timeout: 10000 }
    );
    results.verifyMount = {
      nodeModulesCount: verifyResult.stdout?.trim()
    };

    // Test 3: Benchmark repeated mounts (simulate multiple restores)
    const mountTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      await sandbox.exec('fusermount -u /mnt/sqsh-test 2>/dev/null || true', {
        timeout: 5000
      });
      const start = Date.now();
      await sandbox.exec('squashfuse /tmp/test.sqsh /mnt/sqsh-test', {
        timeout: 30000
      });
      mountTimes.push(Date.now() - start);
    }
    results.repeatedMounts = {
      times: mountTimes,
      avgMs: mountTimes.reduce((a, b) => a + b, 0) / mountTimes.length
    };

    // Cleanup
    await sandbox.exec('fusermount -u /mnt/sqsh-test 2>/dev/null || true', {
      timeout: 5000
    });

    return c.json({
      success: true,
      results,
      summary: {
        createTimeMs: results.createSquashfs,
        mountTimeMs: results.mountSquashfs,
        avgMountMs: (results.repeatedMounts as { avgMs: number }).avgMs,
        note: 'Mount is instant - no file extraction needed!'
      }
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: errorMsg });
  }
});

// Root redirect
app.get('/', (c) => {
  return c.redirect('/demo');
});

export default app;
