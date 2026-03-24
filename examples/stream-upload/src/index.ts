import { getSandbox, streamFile } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const sandbox = getSandbox(env.Sandbox, 'stream-upload');
    await sandbox.start();

    if (url.pathname === '/') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleUpload(request, sandbox);
    }

    if (url.pathname === '/download' && request.method === 'GET') {
      return handleDownload(url, sandbox);
    }

    return new Response('Not Found', { status: 404 });
  }
};

type SandboxInstance = ReturnType<typeof getSandbox>;

async function handleUpload(
  request: Request,
  sandbox: SandboxInstance
): Promise<Response> {
  const url = new URL(request.url);
  const filename = url.searchParams.get('filename');

  if (!filename) {
    return Response.json(
      { error: 'Missing filename query parameter' },
      { status: 400 }
    );
  }

  if (!request.body) {
    return Response.json({ error: 'Missing request body' }, { status: 400 });
  }

  const path = `/workspace/${filename}`;

  try {
    const result = await sandbox.writeFile(path, request.body);
    return Response.json({ success: result.success, path: result.path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleDownload(
  url: URL,
  sandbox: SandboxInstance
): Promise<Response> {
  const path = url.searchParams.get('path');

  if (!path) {
    return Response.json(
      { error: 'Missing path query parameter' },
      { status: 400 }
    );
  }

  try {
    const sseStream = await sandbox.readFileStream(path);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of streamFile(sseStream)) {
            if (chunk instanceof Uint8Array) {
              controller.enqueue(chunk);
            } else {
              controller.enqueue(encoder.encode(chunk));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    });
    return new Response(body, {
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Stream Upload Demo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100dvh; padding: 24px;
  }
  .card {
    background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 32px; max-width: 520px; width: 100%;
  }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  label {
    display: block; font-size: 13px; font-weight: 600;
    color: #aaa; margin-bottom: 8px;
  }
  input[type="file"] {
    width: 100%; padding: 10px; border: 1px dashed #444;
    border-radius: 8px; background: #111; color: #ccc;
    cursor: pointer; margin-bottom: 16px;
  }
  button {
    width: 100%; padding: 10px; border: none; border-radius: 8px;
    background: #2563eb; color: #fff; font-size: 14px; font-weight: 600;
    cursor: pointer; transition: background 0.15s;
  }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #333; color: #666; cursor: not-allowed; }
  .status {
    margin-top: 20px; padding: 16px; border-radius: 8px;
    font-size: 13px; line-height: 1.6; white-space: pre-wrap;
    word-break: break-all;
  }
  .status.info { background: #0c1929; border: 1px solid #1e3a5f; color: #7db8f0; }
  .status.success { background: #0c2912; border: 1px solid #1e5f2e; color: #7df09a; }
  .status.error { background: #290c0c; border: 1px solid #5f1e1e; color: #f07d7d; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>writeFile Streaming Demo</h1>
  <p class="subtitle">Upload a file to a sandbox, download it back, and verify integrity.</p>

  <label for="file-input">Choose a file</label>
  <input type="file" id="file-input" />
  <button id="upload-btn" disabled>Upload &amp; Verify</button>

  <div id="status" class="status hidden"></div>
</div>

<script>
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const statusEl  = document.getElementById('status');

fileInput.addEventListener('change', () => {
  uploadBtn.disabled = !fileInput.files.length;
});

uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  uploadBtn.disabled = true;
  setStatus('info', 'Reading original file...');

  try {
    // 1. Hash the original file in the browser
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const originalHash = await sha256(originalBytes);
    setStatus('info', 'Original SHA-256: ' + originalHash + '\\nUploading (' + formatBytes(originalBytes.length) + ')...');

    // 2. Upload via streaming POST
    const uploadRes = await fetch('/upload?filename=' + encodeURIComponent(file.name), {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
    const uploadData = await uploadRes.json();

    if (!uploadRes.ok || uploadData.error) {
      throw new Error(uploadData.error || 'Upload failed');
    }

    setStatus('info', 'Original SHA-256: ' + originalHash + '\\nUploaded to: ' + uploadData.path + '\\nDownloading back...');

    // 3. Download the file back
    const dlRes = await fetch('/download?path=' + encodeURIComponent(uploadData.path));

    if (!dlRes.ok) {
      throw new Error(await dlRes.json().then(b => b.error) ?? 'Download failed');
    }

    // 4. Decode base64 and hash
    const downloadedBytes = new Uint8Array(await dlRes.arrayBuffer());
    const downloadedHash = await sha256(downloadedBytes);

    // 5. Compare
    const match = originalHash === downloadedHash;
    const result = [
      'Original:   ' + originalHash,
      'Downloaded: ' + downloadedHash,
      'Size: ' + formatBytes(originalBytes.length) + ' -> ' + formatBytes(downloadedBytes.length),
      '',
      match ? 'MATCH - Files are identical' : 'MISMATCH - Files differ!'
    ].join('\\n');

    setStatus(match ? 'success' : 'error', result);
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  } finally {
    uploadBtn.disabled = !fileInput.files.length;
  }
});

async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}


function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function setStatus(type, msg) {
  statusEl.className = 'status ' + type;
  statusEl.textContent = msg;
}
</script>
</body>
</html>`;
}
