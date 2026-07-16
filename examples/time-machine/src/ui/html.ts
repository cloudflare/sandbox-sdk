import { getClientScript } from './client-script';
import { getStyles } from './styles';

export function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Time Machine - Sandbox SDK Demo</title>
  <style>
${getStyles()}  </style>
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
${getClientScript()}  </script>
</body>
</html>`;
}
