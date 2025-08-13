/**
 * Process Isolation
 * 
 * Implements PID namespace isolation to secure the sandbox environment.
 * Executed commands run in isolated namespaces, preventing them from:
 * - Seeing or killing control plane processes (Jupyter, Bun)
 * - Accessing platform secrets in /proc
 * - Hijacking control plane ports
 * 
 * ## Two-Process Architecture
 * 
 * Parent Process (Node.js) → Control Process (Node.js) → Isolated Shell (Bash)
 * 
 * The control process manages the isolated shell and handles all I/O through
 * temp files instead of stdout/stderr parsing. This approach handles:
 * - Binary data without corruption
 * - Large outputs without buffer issues
 * - Command output that might contain markers
 * - Clean recovery when shell dies
 * 
 * ## Why file-based IPC?
 * Initial marker-based parsing (UUID markers in stdout) had too many edge cases.
 * File-based IPC reliably handles any output type.
 * 
 * Requires CAP_SYS_ADMIN capability (available in production).
 * Falls back to regular execution in development.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ExecEvent } from '../../src/types';

// Configuration constants
const CONFIG = {
  // Timeouts (in milliseconds)
  COMMAND_TIMEOUT_MS: 30000,        // 30 seconds for command execution
  READY_TIMEOUT_MS: 5000,           // 5 seconds for control process to initialize
  CLEANUP_INTERVAL_MS: 30000,       // Run cleanup every 30 seconds
  TEMP_FILE_MAX_AGE_MS: 60000,      // Delete temp files older than 60 seconds
  SHUTDOWN_GRACE_PERIOD_MS: 500,    // Grace period for cleanup on shutdown
  
  // Default paths
  DEFAULT_CWD: '/workspace',
  TEMP_DIR: '/tmp'
} as const;

// Types
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  isolation?: boolean;
}

interface ControlMessage {
  type: 'exec' | 'exec_stream' | 'exit';
  id: string;
  command?: string;
  cwd?: string;
}

// Note: buildExecScript helper is now inlined within the generated control script

interface ControlResponse {
  type: 'result' | 'error' | 'ready' | 'stream_event';
  id: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  event?: ExecEvent;
}

// Cache the namespace support check
let namespaceSupport: boolean | null = null;

/**
 * Check if PID namespace isolation is available (requires CAP_SYS_ADMIN).
 * Returns true in production, false in typical development environments.
 */
export function hasNamespaceSupport(): boolean {
  if (namespaceSupport !== null) {
    return namespaceSupport;
  }
  
  try {
    // Actually test if unshare works
    const { execSync } = require('node:child_process');
    execSync('unshare --pid --fork --mount-proc true', { 
      stdio: 'ignore',
      timeout: 1000
    });
    console.log('[Isolation] Namespace support detected (CAP_SYS_ADMIN available)');
    namespaceSupport = true;
    return true;
  } catch (error) {
    console.log('[Isolation] No namespace support (CAP_SYS_ADMIN not available)');
    namespaceSupport = false;
    return false;
  }
}

/**
 * Session with isolated command execution.
 * Maintains state across commands within the session.
 */
export class Session {
  private control: ChildProcess | null = null;
  private ready = false;
  private canIsolate: boolean;
  private pendingCallbacks = new Map<string, {
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  
  constructor(private options: SessionOptions) {
    this.canIsolate = (options.isolation === true) && hasNamespaceSupport();
    if (options.isolation === true && !this.canIsolate) {
      console.log(`[Session] Isolation requested for '${options.name}' but not available`);
    }
  }
  
  async initialize(): Promise<void> {
    const controlScript = this.createControlScript();
    
    // Write control script to temp file
    const scriptPath = `${CONFIG.TEMP_DIR}/control_${randomUUID()}.js`;
    await fs.writeFile(scriptPath, controlScript, 'utf8');
    
    // Start control process
    this.control = spawn('node', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SESSION_NAME: this.options.name,
        SESSION_CWD: this.options.cwd || CONFIG.DEFAULT_CWD,
        SESSION_ISOLATED: this.canIsolate ? '1' : '0',
        ...this.options.env
      }
    });
    
    // Handle control process output
    this.control.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: ControlResponse = JSON.parse(line);
          this.handleControlMessage(msg);
        } catch (e) {
          console.error(`[Session] Failed to parse control message: ${line}`);
        }
      }
    });
    
    // Handle control process errors
    this.control.stderr?.on('data', (data: Buffer) => {
      console.error(`[Session] Control stderr for '${this.options.name}': ${data.toString()}`);
    });
    
    this.control.on('error', (error) => {
      console.error(`[Session] Control process error for '${this.options.name}':`, error);
      this.cleanup(error);
    });
    
    this.control.on('exit', (code) => {
      console.log(`[Session] Control process exited for '${this.options.name}' with code ${code}`);
      this.cleanup(new Error(`Control process exited with code ${code}`));
    });
    
    // Wait for ready signal
    await this.waitForReady();
    
    // Clean up temp script
    await fs.unlink(scriptPath).catch(() => {});
    
    console.log(`[Session] Session '${this.options.name}' initialized successfully`);
  }
  
  /**
   * Generate the control process script that manages the isolated shell.
   * 
   * Generated inline rather than using a separate file to:
   * - Keep everything in one deployable unit
   * - Inject environment variables at creation time
   * - Make the implementation self-contained
   */
  private createControlScript(): string {
    return `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse environment
const sessionName = process.env.SESSION_NAME || 'default';
const sessionCwd = process.env.SESSION_CWD || '${CONFIG.DEFAULT_CWD}';
const isIsolated = process.env.SESSION_ISOLATED === '1';

// Configuration
const COMMAND_TIMEOUT_MS = ${CONFIG.COMMAND_TIMEOUT_MS};
const CLEANUP_INTERVAL_MS = ${CONFIG.CLEANUP_INTERVAL_MS};
const TEMP_FILE_MAX_AGE_MS = ${CONFIG.TEMP_FILE_MAX_AGE_MS};
const TEMP_DIR = '${CONFIG.TEMP_DIR}';

console.error(\`[Control] Starting control process for session '\${sessionName}'\`);

// Track active command files for cleanup
const activeFiles = new Set();

// Cleanup function for orphaned temp files
function cleanupTempFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      // Match our temp file pattern and check age
      if (file.match(/^(cmd|out|err|exit)_[a-f0-9-]+/)) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          // Remove files older than max age that aren't active
          if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS && !activeFiles.has(filePath)) {
            fs.unlinkSync(filePath);
            console.error(\`[Control] Cleaned up orphaned temp file: \${file}\`);
          }
        } catch (e) {
          // File might have been removed already
        }
      }
    });
  } catch (e) {
    console.error('[Control] Cleanup error:', e);
  }
}

// Run cleanup periodically
setInterval(cleanupTempFiles, CLEANUP_INTERVAL_MS);

// Start the shell with or without isolation
const shellCommand = isIsolated
  ? ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc']
  : ['bash', '--norc'];

const shell = spawn(shellCommand[0], shellCommand.slice(1), {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: sessionCwd,
  env: process.env
});

// Track shell health
let shellAlive = true;

shell.on('error', (error) => {
  console.error('[Control] Shell error:', error);
  shellAlive = false;
  process.stdout.write(JSON.stringify({
    type: 'error',
    id: 'shell',
    error: error.message
  }) + '\\n');
});

shell.on('exit', (code) => {
  console.error(\`[Control] Shell exited with code \${code}\`);
  shellAlive = false;
  // Clean up any remaining temp files
  activeFiles.forEach(file => {
    try { fs.unlinkSync(file); } catch (e) {}
  });
  process.exit(code || 1);
});

// Send ready signal
process.stdout.write(JSON.stringify({ type: 'ready', id: 'init' }) + '\\n');

// Track processing state for each command
const processingState = new Map();

// Helper function to build exec script with optional cwd handling
function buildExecScript(cmdFile, outFile, errFile, exitFile, msgId, msgCwd, completionMarker = "DONE") {
  if (msgCwd) {
    // If cwd is provided, change directory for this command only
    // For temporary operations that need specific working directory
    return \`
# Execute command with temporary cwd override
PREV_DIR=$(pwd)
cd "\${msgCwd}" || { echo "Failed to change directory to \${msgCwd}" > \${errFile}; echo 1 > \${exitFile}; echo "\${completionMarker}:\${msgId}"; return; }
source \${cmdFile} > \${outFile} 2> \${errFile}
echo $? > \${exitFile}
cd "$PREV_DIR"
echo "\${completionMarker}:\${msgId}"
\`;
  } else {
    // Default behavior - execute in current directory (preserves session state)
    return \`
# Execute command in current shell - maintains working directory changes
source \${cmdFile} > \${outFile} 2> \${errFile}
echo $? > \${exitFile}
echo "\${completionMarker}:\${msgId}"
\`;
  }
}

// Handle commands from parent
process.stdin.on('data', async (data) => {
  const lines = data.toString().split('\\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const msg = JSON.parse(line);
      
      if (msg.type === 'exit') {
        shell.kill('SIGTERM');
        process.exit(0);
      }
      
      if (msg.type === 'exec' && msg.command) {
        if (!shellAlive) {
          process.stdout.write(JSON.stringify({
            type: 'error',
            id: msg.id,
            error: 'Shell is not alive'
          }) + '\\n');
          continue;
        }
        
        // Create temp files for this command
        const cmdFile = \`\${TEMP_DIR}/cmd_\${msg.id}.sh\`;
        const outFile = \`\${TEMP_DIR}/out_\${msg.id}\`;
        const errFile = \`\${TEMP_DIR}/err_\${msg.id}\`;
        const exitFile = \`\${TEMP_DIR}/exit_\${msg.id}\`;
        
        // Track these files as active
        activeFiles.add(cmdFile);
        activeFiles.add(outFile);
        activeFiles.add(errFile);
        activeFiles.add(exitFile);
        
        // Initialize processing state to prevent race conditions
        processingState.set(msg.id, false);
        
        // Write command to file
        fs.writeFileSync(cmdFile, msg.command, 'utf8');
        
        // Use 'source' instead of 'bash' to maintain shell state across commands
        // - 'bash script.sh' creates a subshell (loses pwd, env vars)
        // - 'source script.sh' runs in current shell (preserves state)
        // File-based I/O handles any output type (binary, large, special chars)
        
        const execScript = buildExecScript(cmdFile, outFile, errFile, exitFile, msg.id, msg.cwd);
        
        shell.stdin.write(execScript);
        
        // Set up listener for completion with race condition protection
        const onData = (chunk) => {
          const output = chunk.toString();
          if (output.includes(\`DONE:\${msg.id}\`)) {
            // Check if already processed (prevents race condition)
            if (processingState.get(msg.id)) {
              return;
            }
            processingState.set(msg.id, true);
            
            // Clear timeout to prevent double cleanup
            clearTimeout(timeoutId);
            shell.stdout.off('data', onData);
            
            try {
              // Read results
              const stdout = fs.readFileSync(outFile, 'utf8');
              const stderr = fs.readFileSync(errFile, 'utf8');
              const exitCode = parseInt(fs.readFileSync(exitFile, 'utf8').trim());
              
              // Send response
              process.stdout.write(JSON.stringify({
                type: 'result',
                id: msg.id,
                stdout,
                stderr,
                exitCode
              }) + '\\n');
              
              // Cleanup temp files
              const filesToClean = [cmdFile, outFile, errFile, exitFile];
              filesToClean.forEach(file => {
                try {
                  fs.unlinkSync(file);
                  activeFiles.delete(file);
                } catch (e) {
                  // File might already be deleted
                }
              });
              
              // Clean up processing state
              processingState.delete(msg.id);
            } catch (error) {
              process.stdout.write(JSON.stringify({
                type: 'error',
                id: msg.id,
                error: \`Failed to read output: \${error.message}\`
              }) + '\\n');
              
              // Still try to clean up files on error
              [cmdFile, outFile, errFile, exitFile].forEach(file => {
                try {
                  fs.unlinkSync(file);
                  activeFiles.delete(file);
                } catch (e) {}
              });
              processingState.delete(msg.id);
            }
          }
        };
        
        // Set up timeout first so we can clear it on success
        const timeoutId = setTimeout(() => {
          // Check if already processed
          if (!processingState.get(msg.id)) {
            processingState.set(msg.id, true);
            
            shell.stdout.off('data', onData);
            process.stdout.write(JSON.stringify({
              type: 'error',
              id: msg.id,
              error: \`Command timeout after \${COMMAND_TIMEOUT_MS/1000} seconds\`
            }) + '\\n');
            
            // Cleanup files
            const filesToClean = [cmdFile, outFile, errFile, exitFile];
            filesToClean.forEach(file => {
              try {
                fs.unlinkSync(file);
                activeFiles.delete(file);
              } catch (e) {
                // Silent cleanup - file might already be deleted
              }
            });
            
            processingState.delete(msg.id);
          }
        }, COMMAND_TIMEOUT_MS);
        
        shell.stdout.on('data', onData);
      }
      
      if (msg.type === 'exec_stream' && msg.command) {
        if (!shellAlive) {
          process.stdout.write(JSON.stringify({
            type: 'stream_event',
            id: msg.id,
            event: {
              type: 'error',
              timestamp: new Date().toISOString(),
              command: msg.command,
              error: 'Shell is not alive'
            }
          }) + '\\n');
          continue;
        }
        
        // Create temp files for this command
        const cmdFile = \`\${TEMP_DIR}/cmd_\${msg.id}.sh\`;
        const outFile = \`\${TEMP_DIR}/out_\${msg.id}\`;
        const errFile = \`\${TEMP_DIR}/err_\${msg.id}\`;
        const exitFile = \`\${TEMP_DIR}/exit_\${msg.id}\`;
        
        // Track these files as active
        activeFiles.add(cmdFile);
        activeFiles.add(outFile);
        activeFiles.add(errFile);
        activeFiles.add(exitFile);
        
        // Initialize processing state to prevent race conditions
        processingState.set(msg.id, false);
        
        // Write command to file
        fs.writeFileSync(cmdFile, msg.command, 'utf8');
        
        // Start streaming output
        let stdoutSize = 0;
        let stderrSize = 0;
        
        // Send start event
        process.stdout.write(JSON.stringify({
          type: 'stream_event',
          id: msg.id,
          event: {
            type: 'start',
            timestamp: new Date().toISOString(),
            command: msg.command
          }
        }) + '\\n');
        
        // Set up streaming interval to check for new output
        const streamingInterval = setInterval(() => {
          try {
            // Check for new stdout
            if (fs.existsSync(outFile)) {
              const currentStdout = fs.readFileSync(outFile, 'utf8');
              if (currentStdout.length > stdoutSize) {
                const newData = currentStdout.slice(stdoutSize);
                stdoutSize = currentStdout.length;
                process.stdout.write(JSON.stringify({
                  type: 'stream_event',
                  id: msg.id,
                  event: {
                    type: 'stdout',
                    timestamp: new Date().toISOString(),
                    data: newData,
                    command: msg.command
                  }
                }) + '\\n');
              }
            }
            
            // Check for new stderr
            if (fs.existsSync(errFile)) {
              const currentStderr = fs.readFileSync(errFile, 'utf8');
              if (currentStderr.length > stderrSize) {
                const newData = currentStderr.slice(stderrSize);
                stderrSize = currentStderr.length;
                process.stdout.write(JSON.stringify({
                  type: 'stream_event',
                  id: msg.id,
                  event: {
                    type: 'stderr',
                    timestamp: new Date().toISOString(),
                    data: newData,
                    command: msg.command
                  }
                }) + '\\n');
              }
            }
          } catch (e) {
            // Files might not exist yet, that's ok
          }
        }, 50); // Check every 50ms for real-time feel
        
        // Execute command with same pattern as regular exec, including cwd support
        const execScript = buildExecScript(cmdFile, outFile, errFile, exitFile, msg.id, msg.cwd, "STREAM_DONE");
        
        shell.stdin.write(execScript);
        
        // Set up listener for completion
        const onStreamData = (chunk) => {
          const output = chunk.toString();
          if (output.includes(\`STREAM_DONE:\${msg.id}\`)) {
            // Check if already processed (prevents race condition)
            if (processingState.get(msg.id)) {
              return;
            }
            processingState.set(msg.id, true);
            
            // Clear timeout to prevent double cleanup
            clearTimeout(streamTimeoutId);
            clearInterval(streamingInterval);
            shell.stdout.off('data', onStreamData);
            
            try {
              // Read final results
              const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
              const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
              const exitCode = fs.existsSync(exitFile) ? parseInt(fs.readFileSync(exitFile, 'utf8').trim()) : 1;
              
              // Send any remaining output
              if (stdout.length > stdoutSize) {
                const newData = stdout.slice(stdoutSize);
                process.stdout.write(JSON.stringify({
                  type: 'stream_event',
                  id: msg.id,
                  event: {
                    type: 'stdout',
                    timestamp: new Date().toISOString(),
                    data: newData,
                    command: msg.command
                  }
                }) + '\\n');
              }
              
              if (stderr.length > stderrSize) {
                const newData = stderr.slice(stderrSize);
                process.stdout.write(JSON.stringify({
                  type: 'stream_event',
                  id: msg.id,
                  event: {
                    type: 'stderr',
                    timestamp: new Date().toISOString(),
                    data: newData,
                    command: msg.command
                  }
                }) + '\\n');
              }
              
              // Send completion event
              process.stdout.write(JSON.stringify({
                type: 'stream_event',
                id: msg.id,
                event: {
                  type: 'complete',
                  timestamp: new Date().toISOString(),
                  command: msg.command,
                  exitCode: exitCode,
                  result: {
                    stdout,
                    stderr,
                    exitCode,
                    success: exitCode === 0
                  }
                }
              }) + '\\n');
              
              // Cleanup temp files
              const filesToClean = [cmdFile, outFile, errFile, exitFile];
              filesToClean.forEach(file => {
                try {
                  fs.unlinkSync(file);
                  activeFiles.delete(file);
                } catch (e) {
                  // File might already be deleted
                }
              });
              
              // Clean up processing state
              processingState.delete(msg.id);
            } catch (error) {
              process.stdout.write(JSON.stringify({
                type: 'stream_event',
                id: msg.id,
                event: {
                  type: 'error',
                  timestamp: new Date().toISOString(),
                  command: msg.command,
                  error: \`Failed to read output: \${error.message}\`
                }
              }) + '\\n');
              
              // Still try to clean up files on error
              [cmdFile, outFile, errFile, exitFile].forEach(file => {
                try {
                  fs.unlinkSync(file);
                  activeFiles.delete(file);
                } catch (e) {}
              });
              processingState.delete(msg.id);
            }
          }
        };
        
        // Set up timeout first so we can clear it on success  
        const streamTimeoutId = setTimeout(() => {
          // Check if already processed
          if (!processingState.get(msg.id)) {
            processingState.set(msg.id, true);
            
            clearInterval(streamingInterval);
            shell.stdout.off('data', onStreamData);
            
            process.stdout.write(JSON.stringify({
              type: 'stream_event',
              id: msg.id,
              event: {
                type: 'error',
                timestamp: new Date().toISOString(),
                command: msg.command,
                error: \`Command timeout after \${COMMAND_TIMEOUT_MS/1000} seconds\`
              }
            }) + '\\n');
            
            // Cleanup files
            const filesToClean = [cmdFile, outFile, errFile, exitFile];
            filesToClean.forEach(file => {
              try {
                fs.unlinkSync(file);
                activeFiles.delete(file);
              } catch (e) {
                // Silent cleanup - file might already be deleted
              }
            });
            
            processingState.delete(msg.id);
          }
        }, COMMAND_TIMEOUT_MS);
        
        shell.stdout.on('data', onStreamData);
      }
    } catch (e) {
      console.error('[Control] Failed to parse command:', e);
    }
  }
});

// Cleanup on exit
process.on('exit', () => {
  activeFiles.forEach(file => {
    try { fs.unlinkSync(file); } catch (e) {}
  });
});

// Keep process alive
process.stdin.resume();
`;
  }
  
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Control process initialization timeout'));
      }, CONFIG.READY_TIMEOUT_MS);
      
      const checkReady = (msg: ControlResponse) => {
        if (msg.type === 'ready' && msg.id === 'init') {
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        }
      };
      
      // Temporarily store the ready handler
      const originalHandler = this.handleControlMessage;
      this.handleControlMessage = (msg) => {
        checkReady(msg);
        originalHandler.call(this, msg);
      };
    });
  }
  
  private handleControlMessage(msg: ControlResponse): void {
    if (msg.type === 'ready' && msg.id === 'init') {
      this.ready = true;
      return;
    }
    
    const callback = this.pendingCallbacks.get(msg.id);
    if (!callback) return;
    
    clearTimeout(callback.timeout);
    this.pendingCallbacks.delete(msg.id);
    
    if (msg.type === 'error') {
      callback.reject(new Error(msg.error || 'Unknown error'));
    } else if (msg.type === 'result') {
      callback.resolve({
        stdout: msg.stdout || '',
        stderr: msg.stderr || '',
        exitCode: msg.exitCode || 0
      });
    }
  }
  
  private cleanup(error?: Error): void {
    // Reject all pending callbacks
    for (const [id, callback] of this.pendingCallbacks) {
      clearTimeout(callback.timeout);
      callback.reject(error || new Error('Session terminated'));
    }
    this.pendingCallbacks.clear();
    
    // Kill control process if still running
    if (this.control && !this.control.killed) {
      this.control.kill('SIGTERM');
    }
    
    this.control = null;
    this.ready = false;
  }
  
  async exec(command: string, options?: { cwd?: string }): Promise<ExecResult> {
    if (!this.ready || !this.control) {
      throw new Error(`Session '${this.options.name}' not initialized`);
    }
    
    const id = randomUUID();
    
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(new Error(`Command timeout: ${command}`));
      }, CONFIG.COMMAND_TIMEOUT_MS);
      
      // Store callback
      this.pendingCallbacks.set(id, { resolve, reject, timeout });
      
      // Send command to control process with cwd override
      const msg: ControlMessage = { 
        type: 'exec', 
        id, 
        command,
        cwd: options?.cwd // Pass through cwd override if provided
      };
      this.control!.stdin?.write(`${JSON.stringify(msg)}\n`);
    });
  }

  async *execStream(command: string, options?: { cwd?: string }): AsyncGenerator<ExecEvent> {
    if (!this.ready || !this.control) {
      throw new Error(`Session '${this.options.name}' not initialized`);
    }
    
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    
    // Yield start event
    yield {
      type: 'start',
      timestamp,
      command,
    };
    
    // Set up streaming callback handling
    const streamingCallbacks = new Map<string, {
      resolve: () => void;
      reject: (error: Error) => void;
      events: ExecEvent[];
      complete: boolean;
    }>();
    
    // Temporarily override message handling to capture streaming events
    const originalHandler = this.control!.stdout?.listeners('data')[0];
    
    const streamHandler = (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: any = JSON.parse(line);
          if (msg.type === 'stream_event' && msg.id === id) {
            const callback = streamingCallbacks.get(id);
            if (callback) {
              callback.events.push(msg.event);
              if (msg.event.type === 'complete' || msg.event.type === 'error') {
                callback.complete = true;
                callback.resolve();
              }
            }
          } else {
            // Pass through other messages to original handler
            originalHandler?.(data);
          }
        } catch (e) {
          console.error(`[Session] Failed to parse stream message: ${line}`);
        }
      }
    };
    
    try {
      // Set up promise for completion
      const streamPromise = new Promise<void>((resolve, reject) => {
        streamingCallbacks.set(id, {
          resolve,
          reject,
          events: [],
          complete: false
        });
        
        // Set up timeout
        setTimeout(() => {
          const callback = streamingCallbacks.get(id);
          if (callback && !callback.complete) {
            streamingCallbacks.delete(id);
            reject(new Error(`Stream timeout: ${command}`));
          }
        }, CONFIG.COMMAND_TIMEOUT_MS);
      });
      
      // Replace stdout handler temporarily
      this.control!.stdout?.off('data', originalHandler as any);
      this.control!.stdout?.on('data', streamHandler);
      
      // Send streaming exec command to control process
      const msg: ControlMessage = { 
        type: 'exec_stream', 
        id, 
        command,
        cwd: options?.cwd // Pass through cwd override if provided
      };
      this.control!.stdin?.write(`${JSON.stringify(msg)}\n`);
      
      // Yield events as they come in
      const callback = streamingCallbacks.get(id)!;
      let lastEventIndex = 0;
      
      while (!callback.complete) {
        // Yield any new events
        while (lastEventIndex < callback.events.length) {
          yield callback.events[lastEventIndex];
          lastEventIndex++;
        }
        
        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      // Yield any remaining events
      while (lastEventIndex < callback.events.length) {
        yield callback.events[lastEventIndex];
        lastEventIndex++;
      }
      
      await streamPromise;
      
    } catch (error) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Restore original handler
      this.control!.stdout?.off('data', streamHandler);
      if (originalHandler) {
        this.control!.stdout?.on('data', originalHandler as any);
      }
      streamingCallbacks.delete(id);
    }
  }
  
  // File Operations - Execute as shell commands to inherit session context
  async writeFileOperation(path: string, content: string, encoding: string = 'utf-8'): Promise<{ success: boolean; exitCode: number; path: string }> {
    // Escape content for safe heredoc usage
    const safeContent = content.replace(/'/g, "'\\''");
    
    // Create parent directory if needed, then write file using heredoc
    const command = `mkdir -p "$(dirname "${path}")" && cat > "${path}" << 'SANDBOX_EOF'
${safeContent}
SANDBOX_EOF`;
    
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      path
    };
  }

  async readFileOperation(path: string, encoding: string = 'utf-8'): Promise<{ success: boolean; exitCode: number; content: string; path: string }> {
    const command = `cat "${path}"`;
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      content: result.stdout,
      path
    };
  }

  async mkdirOperation(path: string, recursive: boolean = false): Promise<{ success: boolean; exitCode: number; path: string; recursive: boolean }> {
    const command = recursive ? `mkdir -p "${path}"` : `mkdir "${path}"`;
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      path,
      recursive
    };
  }

  async deleteFileOperation(path: string): Promise<{ success: boolean; exitCode: number; path: string }> {
    const command = `rm "${path}"`;
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      path
    };
  }

  async renameFileOperation(oldPath: string, newPath: string): Promise<{ success: boolean; exitCode: number; oldPath: string; newPath: string }> {
    const command = `mv "${oldPath}" "${newPath}"`;
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      oldPath,
      newPath
    };
  }

  async moveFileOperation(sourcePath: string, destinationPath: string): Promise<{ success: boolean; exitCode: number; sourcePath: string; destinationPath: string }> {
    const command = `mv "${sourcePath}" "${destinationPath}"`;
    const result = await this.exec(command);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      sourcePath,
      destinationPath
    };
  }

  async listFilesOperation(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<{ success: boolean; exitCode: number; files: any[]; path: string }> {
    // Build ls command with appropriate flags
    let lsFlags = '-la'; // Long format with all files (including hidden)
    if (!options?.includeHidden) {
      lsFlags = '-l'; // Long format without hidden files  
    }
    if (options?.recursive) {
      lsFlags += 'R'; // Recursive
    }
    
    const command = `ls ${lsFlags} "${path}" 2>/dev/null || echo "DIRECTORY_NOT_FOUND"`;
    const result = await this.exec(command);
    
    if (result.stdout.includes('DIRECTORY_NOT_FOUND')) {
      return {
        success: false,
        exitCode: 1,
        files: [],
        path
      };
    }
    
    // Parse ls output into structured file data
    const files = this.parseLsOutput(result.stdout, path);
    
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      files,
      path
    };
  }

  private parseLsOutput(lsOutput: string, basePath: string): any[] {
    const lines = lsOutput.split('\n').filter(line => line.trim());
    const files: any[] = [];
    
    for (const line of lines) {
      // Skip total line and empty lines
      if (line.startsWith('total') || !line.trim()) continue;
      
      // Parse ls -l format: permissions, links, user, group, size, date, name
      const match = line.match(/^([\-dlrwx]+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s+(.+)$/);
      if (!match) continue;
      
      const [, permissions, size, dateStr, name] = match;
      
      // Determine file type from first character of permissions
      let type: 'file' | 'directory' | 'symlink' | 'other' = 'file';
      if (permissions.startsWith('d')) type = 'directory';
      else if (permissions.startsWith('l')) type = 'symlink';
      else if (!permissions.startsWith('-')) type = 'other';
      
      // Extract permission booleans for user (first 3 chars after type indicator)
      const userPerms = permissions.substring(1, 4);
      
      files.push({
        name,
        absolutePath: `${basePath}/${name}`,
        relativePath: name,
        type,
        size: parseInt(size),
        modifiedAt: dateStr, // Simplified date parsing
        mode: permissions,
        permissions: {
          readable: userPerms[0] === 'r',
          writable: userPerms[1] === 'w', 
          executable: userPerms[2] === 'x'
        }
      });
    }
    
    return files;
  }

  destroy(): void {
    if (this.control) {
      // Send exit command
      const msg: ControlMessage = { type: 'exit', id: 'destroy' };
      this.control.stdin?.write(`${JSON.stringify(msg)}\n`);
      
      // Give it a moment to exit cleanly
      setTimeout(() => {
        if (this.control && !this.control.killed) {
          this.control.kill('SIGTERM');
        }
      }, 100);
      
      this.cleanup();
    }
  }
}

/**
 * Manages isolated sessions for command execution.
 * Each session maintains its own state (pwd, env vars, processes).
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  
  async createSession(options: SessionOptions): Promise<Session> {
    // Clean up existing session with same name
    const existing = this.sessions.get(options.name);
    if (existing) {
      existing.destroy();
    }
    
    // Create new session
    const session = new Session(options);
    await session.initialize();
    
    this.sessions.set(options.name, session);
    console.log(`[SessionManager] Created session '${options.name}'`);
    return session;
  }
  
  getSession(name: string): Session | undefined {
    return this.sessions.get(name);
  }
  
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  // Helper to get or create default session - reduces duplication
  private async getOrCreateDefaultSession(): Promise<Session> {
    let defaultSession = this.sessions.get('default');
    if (!defaultSession) {
      defaultSession = await this.createSession({ 
        name: 'default',
        cwd: '/workspace', // Consistent default working directory
        isolation: true 
      });
    }
    return defaultSession;
  }
  
  async exec(command: string, options?: { cwd?: string }): Promise<ExecResult> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.exec(command, options);
  }
  
  async *execStream(command: string, options?: { cwd?: string }): AsyncGenerator<ExecEvent> {
    const defaultSession = await this.getOrCreateDefaultSession();
    yield* defaultSession.execStream(command, options);
  }

  // File Operations - Clean method names following existing pattern
  async writeFile(path: string, content: string, encoding?: string): Promise<{ success: boolean; exitCode: number; path: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.writeFileOperation(path, content, encoding);
  }

  async readFile(path: string, encoding?: string): Promise<{ success: boolean; exitCode: number; content: string; path: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.readFileOperation(path, encoding);
  }

  async mkdir(path: string, recursive?: boolean): Promise<{ success: boolean; exitCode: number; path: string; recursive: boolean }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.mkdirOperation(path, recursive);
  }

  async deleteFile(path: string): Promise<{ success: boolean; exitCode: number; path: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.deleteFileOperation(path);
  }

  async renameFile(oldPath: string, newPath: string): Promise<{ success: boolean; exitCode: number; oldPath: string; newPath: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.renameFileOperation(oldPath, newPath);
  }

  async moveFile(sourcePath: string, destinationPath: string): Promise<{ success: boolean; exitCode: number; sourcePath: string; destinationPath: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.moveFileOperation(sourcePath, destinationPath);
  }

  async listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<{ success: boolean; exitCode: number; files: any[]; path: string }> {
    const defaultSession = await this.getOrCreateDefaultSession();
    return defaultSession.listFilesOperation(path, options);
  }
  
  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }
}