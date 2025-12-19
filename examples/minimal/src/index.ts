import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get or create a sandbox instance
    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    // Execute a shell command
    if (url.pathname === '/run') {
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return Response.json({
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
        success: result.success
      });
    }

    // Work with files
    if (url.pathname === '/file') {
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return Response.json({
        content: file.content
      });
    }

    // Reproduce issue #309: child_process.spawn() ENOENT
    if (url.pathname === '/spawn-test') {
      // First, verify the claude binary exists and check its location
      const whichResult = await sandbox.exec('which claude');
      const lsResult = await sandbox.exec('ls -la /usr/local/bin/claude');
      const fileResult = await sandbox.exec('file /usr/local/bin/claude');

      // Test accessSync via Node.js
      const accessTestScript = `
const { accessSync, constants, readFileSync } = require('fs');
const path = '/usr/local/bin/claude';

try {
  accessSync(path, constants.X_OK);
  console.log('accessSync: SUCCESS - binary exists and is executable');

  // Read the shebang to see what interpreter it needs
  const content = readFileSync(path, 'utf8');
  const firstLine = content.split('\\n')[0];
  console.log('Shebang:', firstLine);
} catch (err) {
  console.log('accessSync: FAILED -', err.message);
}
`;

      await sandbox.writeFile('/workspace/access-test.js', accessTestScript);
      const accessResult = await sandbox.exec('node /workspace/access-test.js');

      // Now test spawn with absolute path
      const spawnTestScript = `
const { spawn } = require('child_process');

console.log('Attempting spawn with absolute path...');
console.log('PATH:', process.env.PATH);

const child = spawn('/usr/local/bin/claude', ['--version'], {
  env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' },
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stdout.on('data', (data) => {
  console.log('stdout:', data.toString());
});

child.stderr.on('data', (data) => {
  console.log('stderr:', data.toString());
});

child.on('error', (err) => {
  console.log('spawn error:', err.code, err.message);
});

child.on('close', (code) => {
  console.log('exit code:', code);
});
`;

      await sandbox.writeFile('/workspace/spawn-test.js', spawnTestScript);
      const spawnResult = await sandbox.exec('node /workspace/spawn-test.js');

      return Response.json({
        which: whichResult.stdout.trim(),
        ls: lsResult.stdout.trim(),
        file: fileResult.stdout.trim(),
        accessTest: {
          stdout: accessResult.stdout,
          stderr: accessResult.stderr,
          exitCode: accessResult.exitCode
        },
        spawnTest: {
          stdout: spawnResult.stdout,
          stderr: spawnResult.stderr,
          exitCode: spawnResult.exitCode
        }
      });
    }

    // Test Claude Agent SDK spawn (closer to issue reproduction)
    if (url.pathname === '/agent-sdk-test') {
      // Test using the Claude Agent SDK like the issue reporter
      const agentSdkTestScript = `
const { spawn } = require('child_process');
const { accessSync, constants, realpathSync, statSync, existsSync } = require('fs');
const path = require('path');

async function runTest() {
  const results = {};

  // 1. Check PATH
  results.PATH = process.env.PATH;

  // 2. Check the binary location
  const claudePath = '/usr/local/bin/claude';
  results.claudePath = claudePath;

  // 3. Check if it exists
  try {
    accessSync(claudePath, constants.X_OK);
    results.accessSync = 'SUCCESS';
  } catch (err) {
    results.accessSync = 'FAILED: ' + err.message;
  }

  // 4. Check the symlink target
  try {
    results.realpath = realpathSync(claudePath);
  } catch (err) {
    results.realpath = 'ERROR: ' + err.message;
  }

  // 5. Check if the target exists
  try {
    const realPath = realpathSync(claudePath);
    results.targetExists = existsSync(realPath);
    results.targetStats = statSync(realPath);
  } catch (err) {
    results.targetError = err.message;
  }

  // 6. Check node executable
  results.nodeExecutable = process.execPath;

  // 7. Now try spawning with the Claude Agent SDK approach
  // (simulating what the SDK does internally)
  const promise = new Promise((resolve, reject) => {
    const child = spawn(claudePath, ['--version'], {
      env: {
        ...process.env,
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      resolve({
        error: err.code + ': ' + err.message,
        stdout,
        stderr
      });
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr
      });
    });
  });

  results.spawnResult = await promise;

  console.log(JSON.stringify(results, null, 2));
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
`;

      await sandbox.writeFile(
        '/workspace/agent-sdk-test.js',
        agentSdkTestScript
      );
      const result = await sandbox.exec('node /workspace/agent-sdk-test.js');

      try {
        const parsed = JSON.parse(result.stdout);
        return Response.json({
          success: true,
          result: parsed,
          stderr: result.stderr,
          exitCode: result.exitCode
        });
      } catch {
        return Response.json({
          success: false,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        });
      }
    }

    return new Response('Try /run, /file, /spawn-test, or /agent-sdk-test');
  }
};
