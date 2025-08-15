#!/usr/bin/env node

/**
 * Control Process for Isolated Command Execution
 * 
 * This process manages an isolated bash shell and executes commands within it.
 * It communicates with the parent process via stdin/stdout using JSON messages.
 * 
 * Architecture:
 * - Receives commands via stdin as JSON messages
 * - Executes them in a bash shell (with optional PID namespace isolation)
 * - Returns results via stdout as JSON messages
 * - Uses file-based IPC for reliable handling of any output type
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Parse environment configuration
const sessionId = process.env.SESSION_ID || 'default';
const sessionCwd = process.env.SESSION_CWD || '/workspace';
const isIsolated = process.env.SESSION_ISOLATED === '1';

// Configuration constants (can be overridden via env vars)
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || '30000');
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || '30000');
const TEMP_FILE_MAX_AGE_MS = parseInt(process.env.TEMP_FILE_MAX_AGE_MS || '60000');
const TEMP_DIR = process.env.TEMP_DIR || '/tmp';

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
 * Send a response to the parent process
 */
function sendResponse(response: ControlResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/**
 * Log to stderr for debugging (visible in parent process logs)
 */
function logError(message: string, error?: any): void {
  console.error(`[Control] ${message}`, error || '');
}

/**
 * Clean up orphaned temp files periodically
 */
function cleanupTempFiles(): void {
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
  if (msgCwd) {
    // If cwd is provided, change directory for this command only
    return `
# Execute command with temporary cwd override
PREV_DIR=$(pwd)
cd "${msgCwd}" || { echo "Failed to change directory to ${msgCwd}" > ${errFile}; echo 1 > ${exitFile}; echo "${completionMarker}:${msgId}"; return; }
source ${cmdFile} > ${outFile} 2> ${errFile}
echo $? > ${exitFile}
cd "$PREV_DIR"
echo "${completionMarker}:${msgId}"
`;
  } else {
    // Default behavior - execute in current directory (preserves session state)
    return `
# Execute command in current shell - maintains working directory changes
source ${cmdFile} > ${outFile} 2> ${errFile}
echo $? > ${exitFile}
echo "${completionMarker}:${msgId}"
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
  
  // Create temp files for this command
  const cmdFile = `${TEMP_DIR}/cmd_${msg.id}.sh`;
  const outFile = `${TEMP_DIR}/out_${msg.id}`;
  const errFile = `${TEMP_DIR}/err_${msg.id}`;
  const exitFile = `${TEMP_DIR}/exit_${msg.id}`;
  
  // Track these files as active
  activeFiles.add(cmdFile);
  activeFiles.add(outFile);
  activeFiles.add(errFile);
  activeFiles.add(exitFile);
  
  // Initialize processing state to prevent race conditions
  processingState.set(msg.id, false);
  
  // Write command to file
  fs.writeFileSync(cmdFile, msg.command, 'utf8');
  
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
        
        // Cleanup temp files
        [cmdFile, outFile, errFile, exitFile].forEach(file => {
          try {
            fs.unlinkSync(file);
            activeFiles.delete(file);
          } catch (e) {
            // File might already be deleted
          }
        });
        
        // Clean up processing state
        processingState.delete(msg.id);
      } catch (error: any) {
        sendResponse({
          type: 'error',
          id: msg.id,
          error: `Failed to read output: ${error.message}`
        });
        
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
      
      // Cleanup files
      [cmdFile, outFile, errFile, exitFile].forEach(file => {
        try {
          fs.unlinkSync(file);
          activeFiles.delete(file);
        } catch (e) {}
      });
      
      processingState.delete(msg.id);
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
  
  // Create temp files for this command
  const cmdFile = `${TEMP_DIR}/cmd_${msg.id}.sh`;
  const outFile = `${TEMP_DIR}/out_${msg.id}`;
  const errFile = `${TEMP_DIR}/err_${msg.id}`;
  const exitFile = `${TEMP_DIR}/exit_${msg.id}`;
  
  // Track these files as active
  activeFiles.add(cmdFile);
  activeFiles.add(outFile);
  activeFiles.add(errFile);
  activeFiles.add(exitFile);
  
  // Initialize processing state
  processingState.set(msg.id, false);
  
  // Write command to file
  fs.writeFileSync(cmdFile, msg.command, 'utf8');
  
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
        
        // Cleanup temp files
        [cmdFile, outFile, errFile, exitFile].forEach(file => {
          try {
            fs.unlinkSync(file);
            activeFiles.delete(file);
          } catch (e) {}
        });
        
        processingState.delete(msg.id);
      } catch (error: any) {
        sendResponse({
          type: 'stream_event',
          id: msg.id,
          event: {
            type: 'error',
            timestamp: new Date().toISOString(),
            command: msg.command,
            error: `Failed to read output: ${error.message}`
          }
        });
        
        // Clean up files on error
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
      
      // Cleanup files
      [cmdFile, outFile, errFile, exitFile].forEach(file => {
        try {
          fs.unlinkSync(file);
          activeFiles.delete(file);
        } catch (e) {}
      });
      
      processingState.delete(msg.id);
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
      logError(`Unknown message type: ${(msg as any).type}`);
  }
}

/**
 * Initialize the shell process
 */
function initializeShell(): void {
  logError(`Starting control process for session '${sessionId}'`);
  
  // Start the shell with or without isolation
  const shellCommand = isIsolated
    ? ['unshare', '--pid', '--fork', '--mount-proc', 'bash', '--norc']
    : ['bash', '--norc'];
  
  shell = spawn(shellCommand[0], shellCommand.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: sessionCwd,
    env: process.env
  });
  
  // Handle shell errors
  shell.on('error', (error) => {
    logError('Shell error:', error);
    shellAlive = false;
    sendResponse({
      type: 'error',
      id: 'shell',
      error: error.message
    });
  });
  
  // Handle shell exit
  shell.on('exit', (code) => {
    logError(`Shell exited with code ${code}`);
    shellAlive = false;
    
    // Clean up any remaining temp files
    activeFiles.forEach(file => {
      try { fs.unlinkSync(file); } catch (e) {}
    });
    
    process.exit(code || 1);
  });
  
  // Send ready signal
  sendResponse({ type: 'ready', id: 'init' });
}

/**
 * Main entry point
 */
function main(): void {
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
      } catch (e: any) {
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