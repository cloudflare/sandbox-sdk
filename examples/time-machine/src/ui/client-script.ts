export function getClientScript(): string {
  return `    const terminal = document.getElementById('terminal');
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
`;
}
