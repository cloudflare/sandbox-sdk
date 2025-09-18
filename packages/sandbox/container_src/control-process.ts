#!/usr/bin/env node

/**
 * Control Process for Isolated Command Execution
 * 
 * This process manages a persistent bash shell with optional namespace isolation.
 * It maintains session state (pwd, env vars) across commands while providing
 * security isolation when requested.
 * 
 * Architecture:
 * - Receives commands via stdin as JSON messages
 * - Executes them in a persistent bash shell
 * - Optionally uses Linux 'unshare' for PID namespace isolation
 * - Returns results via stdout as JSON messages
 * - Uses file-based IPC for reliable handling of any output type
 * 
 * Isolation (when enabled):
 * - Uses 'unshare --pid --fork --mount-proc' from util-linux
 * - Creates PID namespace: sandboxed code cannot see host processes
 * - Mounts isolated /proc: hides platform secrets and control plane
 * - Requires CAP_SYS_ADMIN capability (available in production)
 * - Falls back gracefully to non-isolated mode if unavailable
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { escapeShellArg, escapeShellPath } from './shell-escape';

// Parse environment configuration
const sessionId = process.env.SESSION_ID || 'default';
const sessionCwd = process.env.SESSION_CWD || '/workspace';
let isIsolated = process.env.SESSION_ISOLATED === '1';

// Configuration constants (can be overridden via env vars)
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '30000');
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '30000');
const TEMP_FILE_MAX_AGE_MS = parseInt(process.env.TEMP_FILE_MAX_AGE_MS || '60000');

// Secure temp directory setup
const BASE_TEMP_DIR = process.env.TEMP_DIR || '/tmp';
let SECURE_TEMP_DIR: string;
const TEMP_DIR_PERMISSIONS = 0o700; // rwx------ (only owner can access)
const TEMP_FILE_PERMISSIONS = 0o600; // rw------- (only owner can read/write)

// Message types for communication with parent process
interface ControlMessage {
  type: 'exec' | 'exec_stream' | 'exit';
  id: string;
  command?: string;
  cwd?: string;
}

interface ControlResponse {
  type: 'result' | 'error' | 'ready' | 'stream_event';
  id: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  event?: StreamEvent;
}

interface StreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'complete' | 'error';
  timestamp: string;
  command?: string;
  data?: string;
  exitCode?: number;
  error?: string;
  result?: {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  };
}

// Track active command files for cleanup
const activeFiles = new Set<string>();

// Track processing state for each command to prevent race conditions
const processingState = new Map<string, boolean>();

// The shell process we're managing
let shell: ChildProcess;
let shellAlive = true;

/**
 * Initialize secure temp directory with proper permissions
 * Creates a process-specific directory to prevent race conditions and unauthorized access
 */
function initializeSecureTempDir(): void {
  // Create a unique directory name using process ID and random bytes
  const processId = process.pid;
  const randomBytes = crypto.randomBytes(8).toString('hex');
  const dirName = `sandbox_${sessionId}_${processId}_${randomBytes}`;
  
  SECURE_TEMP_DIR = path.join(BASE_TEMP_DIR, dirName);
  
  try {
    // Create the directory with restrictive permissions (700 - only owner can access)
    fs.mkdirSync(SECURE_TEMP_DIR, { mode: TEMP_DIR_PERMISSIONS });
    logError(`Created secure temp directory: ${SECURE_TEMP_DIR}`);
    
    // Register cleanup on process exit
    const cleanup = () => {
      try {
        // Remove all files in the directory
        const files = fs.readdirSync(SECURE_TEMP_DIR);
        files.forEach(file => {
          try {
            fs.unlinkSync(path.join(SECURE_TEMP_DIR, file));
          } catch (e) {
            // Ignore individual file errors during cleanup
          }
        });
        // Remove the directory itself
        fs.rmdirSync(SECURE_TEMP_DIR);
        logError(`Cleaned up secure temp directory: ${SECURE_TEMP_DIR}`);
      } catch (e) {
        logError(`Failed to cleanup temp directory: ${e}`);
      }
    };
    
    // Register cleanup handlers
    process.on('exit', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
  } catch (error) {
    logError(`Failed to create secure temp directory: ${error}`);
    // Fall back to using the base temp dir if we can't create a secure one
    SECURE_TEMP_DIR = BASE_TEMP_DIR;
  }
}

/**
 * Create a secure temp file with proper permissions
 * @param prefix - File prefix (cmd, out, err, exit)
 * @param id - Command ID
 * @returns Full path to the created file
 */
function createSecureTempFile(prefix: string, id: string): string {
  // Use crypto.randomBytes for additional entropy in filename
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const filename = `${prefix}_${id}_${randomSuffix}`;
  const filepath = path.join(SECURE_TEMP_DIR, filename);
  
  // Create empty file with restrictive permissions (600 - only owner can read/write)
  const fd = fs.openSync(filepath, 'w', TEMP_FILE_PERMISSIONS);
  fs.closeSync(fd);
  
  return filepath;
}

/**
 * Atomically cleanup temp files for a command
 * Prevents race conditions by using atomic operations
 * @param files - Array of file paths to clean up
 * @param commandId - Command ID for logging
 */
function atomicCleanupFiles(files: string[], commandId: string): void {
  files.forEach(file => {
    try {
      // First, remove from active files set to prevent re-use
      activeFiles.delete(file);
      
      // Attempt to rename file before deletion (atomic operation)
      const deletionMarker = `${file}.deleting`;
      try {
        fs.renameSync(file, deletionMarker);
        fs.unlinkSync(deletionMarker);
      } catch (renameError) {
        // If rename fails, try direct deletion
        fs.unlinkSync(file);
      }
    } catch (e) {
      // File might already be deleted, which is fine
      const error = e as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        logError(`Failed to cleanup file ${file} for command ${commandId}: ${error.message}`);
      }
    }
  });
  
  // Clean up processing state after files are removed
  processingState.delete(commandId);
}

/**
 * Send a response to the parent process
 */
function sendResponse(response: ControlResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/**
 * Log to stderr for debugging (visible in parent process logs)
 */
function logError(message: string, error?: unknown): void {
  console.error(`[Control] ${message}`, error || '');
}

/**
 * Clean up orphaned temp files periodically
 */
function cleanupTempFiles(): void {
  try {
    // Only clean up files in our secure directory
    if (!SECURE_TEMP_DIR || SECURE_TEMP_DIR === BASE_TEMP_DIR) {
      return; // Skip cleanup if we're using the fallback shared directory
    }
    
    const files = fs.readdirSync(SECURE_TEMP_DIR);
    const now = Date.now();
    
    files.forEach(file => {
      // Match our temp file pattern and check age
      if (file.match(/^(cmd|out|err|exit)_[a-f0-9-]+_[a-f0-9]+/)) {
        const filePath = path.join(SECURE_TEMP_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          // Remove files older than max age that aren't active
          if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS && !activeFiles.has(filePath)) {
            fs.unlinkSync(filePath);
            logError(`Cleaned up orphaned temp file: ${file}`);
          }
        } catch (e) {
          // File might have been removed already
        }
      }
    });
  } catch (e) {
    logError('Cleanup error:', e);
  }
}

/**
 * Build the bash script for executing a command with optional cwd override
 */
function buildExecScript(
  cmdFile: string,
  outFile: string,
  errFile: string,
  exitFile: string,
  msgId: string,
  msgCwd?: string,
  completionMarker: string = 'DONE'
): string {
  // Escape all file paths and identifiers to prevent injection
  const safeCmdFile = escapeShellPath(cmdFile);
  const safeOutFile = escapeShellPath(outFile);
  const safeErrFile = escapeShellPath(errFile);
  const safeExitFile = escapeShellPath(exitFile);
  const safeCompletionMarker = escapeShellArg(completionMarker);
  const safeMsgId = escapeShellArg(msgId);
  
  if (msgCwd) {
    // Escape the directory path (validation happens at SDK layer)
    const safeMsgCwd = escapeShellPath(msgCwd);
    
    // If cwd is provided, change directory for this command only
    return `
# Execute command with temporary cwd override
PREV_DIR=$(pwd)
cd ${safeMsgCwd} || { echo "Failed to change directory to ${safeMsgCwd}" > ${safeErrFile}; echo 1 > ${safeExitFile}; echo "${safeCompletionMarker}:${safeMsgId}"; return; }
source ${safeCmdFile} > ${safeOutFile} 2> ${safeErrFile}
echo $? > ${safeExitFile}
cd "$PREV_DIR"
echo "${safeCompletionMarker}:${safeMsgId}"
`;
  } else {
    // Default behavior - execute in current directory (preserves session state)
    return `
# Execute command in current shell - maintains working directory changes
source ${safeCmdFile} > ${safeOutFile} 2> ${safeErrFile}
echo $? > ${safeExitFile}
echo "${safeCompletionMarker}:${safeMsgId}"
`;
  }
}

/**
 * Handle an exec command (non-streaming)
 */
async function handleExecCommand(msg: ControlMessage): Promise<void> {
  if (!shellAlive) {
    sendResponse({
      type: 'error',
      id: msg.id,
      error: 'Shell is not alive'
    });
    return;
  }
  
  if (!msg.command) {
    sendResponse({
      type: 'error',
      id: msg.id,
      error: 'No command provided'
    });
    return;
  }
  
  // Create secure temp files for this command
  const cmdFile = createSecureTempFile('cmd', msg.id);
  const outFile = createSecureTempFile('out', msg.id);
  const errFile = createSecureTempFile('err', msg.id);
  const exitFile = createSecureTempFile('exit', msg.id);
  
  // Track these files as active
  activeFiles.add(cmdFile);
  activeFiles.add(outFile);
  activeFiles.add(errFile);
  activeFiles.add(exitFile);
  
  // Initialize processing state to prevent race conditions
  processingState.set(msg.id, false);
  
  // Write command to file securely (file already has proper permissions)
  fs.writeFileSync(cmdFile, msg.command, { encoding: 'utf8', mode: TEMP_FILE_PERMISSIONS });
  
  // Build and execute the script
  const execScript = buildExecScript(cmdFile, outFile, errFile, exitFile, msg.id, msg.cwd);
  
  // Set up completion handler
  const onData = (chunk: Buffer) => {
    const output = chunk.toString();
    if (output.includes(`DONE:${msg.id}`)) {
      // Check if already processed (prevents race condition)
      if (processingState.get(msg.id)) {
        return;
      }
      processingState.set(msg.id, true);
      
      // Clear timeout to prevent double cleanup
      clearTimeout(timeoutId);
      shell.stdout?.off('data', onData);
      
      try {
        // Read results
        const stdout = fs.readFileSync(outFile, 'utf8');
        const stderr = fs.readFileSync(errFile, 'utf8');
        const exitCode = parseInt(fs.readFileSync(exitFile, 'utf8').trim());
        
        // Send response
        sendResponse({
          type: 'result',
          id: msg.id,
          stdout,
          stderr,
          exitCode
        });
        
        // Atomic cleanup of temp files
        atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
      } catch (error) {
        sendResponse({
          type: 'error',
          id: msg.id,
          error: `Failed to read output: ${error instanceof Error ? error.message : String(error)}`
        });
        
        // Still try to clean up files on error
        atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
      }
    }
  };
  
  // Set up timeout
  const timeoutId = setTimeout(() => {
    // Check if already processed
    if (!processingState.get(msg.id)) {
      processingState.set(msg.id, true);
      
      shell.stdout?.off('data', onData);
      sendResponse({
        type: 'error',
        id: msg.id,
        error: `Command timeout after ${COMMAND_TIMEOUT_MS/1000} seconds`
      });
      
      // Atomic cleanup of temp files
      atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
    }
  }, COMMAND_TIMEOUT_MS);
  
  // Listen for completion marker
  shell.stdout?.on('data', onData);
  
  // Execute the script
  shell.stdin?.write(execScript);
}

/**
 * Handle a streaming exec command
 */
async function handleExecStreamCommand(msg: ControlMessage): Promise<void> {
  if (!shellAlive) {
    sendResponse({
      type: 'stream_event',
      id: msg.id,
      event: {
        type: 'error',
        timestamp: new Date().toISOString(),
        command: msg.command,
        error: 'Shell is not alive'
      }
    });
    return;
  }
  
  if (!msg.command) {
    sendResponse({
      type: 'stream_event',
      id: msg.id,
      event: {
        type: 'error',
        timestamp: new Date().toISOString(),
        error: 'No command provided'
      }
    });
    return;
  }
  
  // Create secure temp files for this command
  const cmdFile = createSecureTempFile('cmd', msg.id);
  const outFile = createSecureTempFile('out', msg.id);
  const errFile = createSecureTempFile('err', msg.id);
  const exitFile = createSecureTempFile('exit', msg.id);
  
  // Track these files as active
  activeFiles.add(cmdFile);
  activeFiles.add(outFile);
  activeFiles.add(errFile);
  activeFiles.add(exitFile);
  
  // Initialize processing state
  processingState.set(msg.id, false);
  
  // Write command to file securely (file already has proper permissions)
  fs.writeFileSync(cmdFile, msg.command, { encoding: 'utf8', mode: TEMP_FILE_PERMISSIONS });
  
  // Track output sizes for incremental streaming
  let stdoutSize = 0;
  let stderrSize = 0;
  
  // Send start event
  sendResponse({
    type: 'stream_event',
    id: msg.id,
    event: {
      type: 'start',
      timestamp: new Date().toISOString(),
      command: msg.command
    }
  });
  
  // Set up streaming interval to check for new output
  const streamingInterval = setInterval(() => {
    try {
      // Check for new stdout
      if (fs.existsSync(outFile)) {
        const currentStdout = fs.readFileSync(outFile, 'utf8');
        if (currentStdout.length > stdoutSize) {
          const newData = currentStdout.slice(stdoutSize);
          stdoutSize = currentStdout.length;
          sendResponse({
            type: 'stream_event',
            id: msg.id,
            event: {
              type: 'stdout',
              timestamp: new Date().toISOString(),
              data: newData,
              command: msg.command
            }
          });
        }
      }
      
      // Check for new stderr
      if (fs.existsSync(errFile)) {
        const currentStderr = fs.readFileSync(errFile, 'utf8');
        if (currentStderr.length > stderrSize) {
          const newData = currentStderr.slice(stderrSize);
          stderrSize = currentStderr.length;
          sendResponse({
            type: 'stream_event',
            id: msg.id,
            event: {
              type: 'stderr',
              timestamp: new Date().toISOString(),
              data: newData,
              command: msg.command
            }
          });
        }
      }
    } catch (e) {
      // Files might not exist yet, that's ok
    }
  }, 100); // Check every 100ms for real-time feel
  
  // Build and execute the script
  const execScript = buildExecScript(cmdFile, outFile, errFile, exitFile, msg.id, msg.cwd, 'STREAM_DONE');
  
  // Set up completion handler
  const onStreamData = (chunk: Buffer) => {
    const output = chunk.toString();
    if (output.includes(`STREAM_DONE:${msg.id}`)) {
      // Check if already processed
      if (processingState.get(msg.id)) {
        return;
      }
      processingState.set(msg.id, true);
      
      // Clear timeout and interval
      clearTimeout(streamTimeoutId);
      clearInterval(streamingInterval);
      shell.stdout?.off('data', onStreamData);
      
      try {
        // Read final results
        const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
        const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
        const exitCode = fs.existsSync(exitFile) ? parseInt(fs.readFileSync(exitFile, 'utf8').trim()) : 1;
        
        // Send any remaining output
        if (stdout.length > stdoutSize) {
          const newData = stdout.slice(stdoutSize);
          sendResponse({
            type: 'stream_event',
            id: msg.id,
            event: {
              type: 'stdout',
              timestamp: new Date().toISOString(),
              data: newData,
              command: msg.command
            }
          });
        }
        
        if (stderr.length > stderrSize) {
          const newData = stderr.slice(stderrSize);
          sendResponse({
            type: 'stream_event',
            id: msg.id,
            event: {
              type: 'stderr',
              timestamp: new Date().toISOString(),
              data: newData,
              command: msg.command
            }
          });
        }
        
        // Send completion event
        sendResponse({
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
        });
        
        // Atomic cleanup of temp files
        atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
      } catch (error) {
        sendResponse({
          type: 'stream_event',
          id: msg.id,
          event: {
            type: 'error',
            timestamp: new Date().toISOString(),
            command: msg.command,
            error: `Failed to read output: ${error instanceof Error ? error.message : String(error)}`
          }
        });
        
        // Clean up files on error
        atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
      }
    }
  };
  
  // Set up timeout
  const streamTimeoutId = setTimeout(() => {
    // Check if already processed
    if (!processingState.get(msg.id)) {
      processingState.set(msg.id, true);
      
      clearInterval(streamingInterval);
      shell.stdout?.off('data', onStreamData);
      
      sendResponse({
        type: 'stream_event',
        id: msg.id,
        event: {
          type: 'error',
          timestamp: new Date().toISOString(),
          command: msg.command,
          error: `Command timeout after ${COMMAND_TIMEOUT_MS/1000} seconds`
        }
      });
      
      // Atomic cleanup of temp files
      atomicCleanupFiles([cmdFile, outFile, errFile, exitFile], msg.id);
    }
  }, COMMAND_TIMEOUT_MS);
  
  // Listen for completion marker
  shell.stdout?.on('data', onStreamData);
  
  // Execute the script
  shell.stdin?.write(execScript);
}

/**
 * Handle incoming control messages from parent process
 */
async function handleControlMessage(msg: ControlMessage): Promise<void> {
  switch (msg.type) {
    case 'exit':
      shell.kill('SIGTERM');
      process.exit(0);
      break;
      
    case 'exec':
      await handleExecCommand(msg);
      break;
      
    case 'exec_stream':
      await handleExecStreamCommand(msg);
      break;
      
    default:
      logError(`Unknown message type: ${(msg as ControlMessage).type}`);
  }
}

/**
 * Initialize the shell process
 * 
 * Creates either an isolated shell using 'unshare' or a regular bash shell.
 * Isolation uses Linux namespaces (PID) to prevent the shell from:
 * - Seeing control plane processes (Bun server)
 * - Accessing platform secrets in /proc/1/environ
 * - Hijacking control plane ports
 */
function initializeShell(): void {
  logError(`Starting control process for session '${sessionId}' (isolation: ${isIsolated})`);
  
  // Build shell command based on isolation requirements
  let shellCommand: string[];
  if (isIsolated) {
    // Use unshare for PID namespace isolation
    // --pid: Create new PID namespace (processes can't see host processes)
    // --fork: Fork before exec (required for PID namespace to work properly)
    // --mount-proc: Mount new /proc filesystem (hides host process info)
    shellCommand = ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc'];
    logError('Using namespace isolation via unshare');
  } else {
    // Regular bash shell without isolation
    shellCommand = ['bash', '--norc'];
    logError('Running without namespace isolation');
  }
  
  // Spawn the shell process
  shell = spawn(shellCommand[0], shellCommand.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: sessionCwd,
    env: process.env
  });
  
  // Handle shell spawn errors (e.g., unshare not found or permission denied)
  shell.on('error', (error: Error & { code?: string }) => {
    logError('Shell spawn error:', error);
    shellAlive = false;
    
    // Provide helpful error messages based on the error
    let errorMessage = error.message;
    if (isIsolated && error.code === 'ENOENT') {
      errorMessage = 'unshare command not found. Namespace isolation requires Linux with util-linux installed.';
    } else if (isIsolated && (error.code === 'EPERM' || error.code === 'EACCES')) {
      errorMessage = 'Permission denied for namespace isolation. CAP_SYS_ADMIN capability required.';
    }
    
    sendResponse({
      type: 'error',
      id: 'shell',
      error: errorMessage
    });
    
    // If isolation failed but not required, try fallback to regular bash
    if (isIsolated && process.env.ISOLATION_FALLBACK !== '0') {
      logError('Attempting fallback to non-isolated shell...');
      isIsolated = false;
      initializeShell(); // Recursive call with isolation disabled
      return;
    }
    
    process.exit(1);
  });
  
  // Handle shell exit
  shell.on('exit', (code) => {
    logError(`Shell exited with code ${code}`);
    shellAlive = false;
    
    // Clean up any remaining temp files atomically
    const filesToClean = Array.from(activeFiles);
    filesToClean.forEach(file => {
      try {
        fs.unlinkSync(file);
        activeFiles.delete(file);
      } catch (e) {
        // Ignore errors during final cleanup
      }
    });
    
    process.exit(code || 1);
  });
  
  // Mark shell as alive if successfully spawned
  if (shell) {
    shellAlive = true;
  }
  
  // Send ready signal once shell is spawned
  sendResponse({ type: 'ready', id: 'init' });
}

/**
 * Main entry point
 */
function main(): void {
  // Initialize secure temp directory first
  initializeSecureTempDir();
  
  // Initialize the shell
  initializeShell();
  
  // Set up periodic cleanup
  setInterval(cleanupTempFiles, CLEANUP_INTERVAL_MS);
  
  // Handle stdin input from parent process
  process.stdin.on('data', async (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const msg = JSON.parse(line) as ControlMessage;
        await handleControlMessage(msg);
      } catch (e) {
        logError('Failed to parse command:', e);
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
}

// Start the control process
main();