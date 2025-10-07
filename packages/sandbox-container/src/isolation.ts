/**
 * Process Isolation
 * 
 * Implements PID namespace isolation to secure the sandbox environment.
 * Executed commands run in isolated namespaces, preventing them from:
 * - Seeing or killing control plane processes (Bun)
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
import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ExecEvent, ExecResult } from '@repo/shared-types';
import type { ProcessRecord, ProcessStatus } from './core/types';

// Configuration constants
const CONFIG = {
  // Timeouts (in milliseconds)
  READY_TIMEOUT_MS: 5000,           // 5 seconds for control process to initialize
  SHUTDOWN_GRACE_PERIOD_MS: 500,    // Grace period for cleanup on shutdown
  COMMAND_TIMEOUT_MS: parseInt(process.env.COMMAND_TIMEOUT_MS || '30000'),        // 30 seconds for command execution
  CLEANUP_INTERVAL_MS: parseInt(process.env.CLEANUP_INTERVAL_MS || '30000'),       // Run cleanup every 30 seconds
  TEMP_FILE_MAX_AGE_MS: parseInt(process.env.TEMP_FILE_MAX_AGE_MS || '60000'),      // Delete temp files older than 60 seconds
  
  // Default paths
  DEFAULT_CWD: '/workspace',
  TEMP_DIR: '/tmp'
} as const;

// Types
// Internal execution result from the isolated process
export interface RawExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SessionOptions {
  id: string;
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
    resolve: (result: RawExecResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private processes = new Map<string, ProcessRecord>();  // Session-specific processes
  
  constructor(private options: SessionOptions) {
    this.canIsolate = (options.isolation === true) && hasNamespaceSupport();
    if (options.isolation === true && !this.canIsolate) {
      console.log(`[Session] Isolation requested for '${options.id}' but not available`);
    }
  }
  
  async initialize(): Promise<void> {
    console.log(`[Session] Initializing session '${this.options.id}'`, {
      isolation: this.options.isolation,
      canIsolate: this.canIsolate,
      cwd: this.options.cwd,
      __dirname
    });

    // Use the proper TypeScript control process file
    const controlProcessPath = path.join(__dirname, 'control-process.js');
    console.log(`[Session] Control process path: ${controlProcessPath}`);

    // Check if file exists before spawning
    try {
      const fs = await import('fs/promises');
      await fs.access(controlProcessPath);
      console.log(`[Session] Control process file exists: ${controlProcessPath}`);
    } catch (err) {
      const error = err as Error;
      console.error(`[Session] Control process file NOT FOUND: ${controlProcessPath}`, error.message);
      throw new Error(`Control process file not found: ${controlProcessPath}`);
    }

    console.log(`[Session] Spawning control process with node ${controlProcessPath}`);

    // Start control process with configuration via environment variables
    try {
      this.control = spawn('node', [controlProcessPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SESSION_ID: this.options.id,
          SESSION_CWD: this.options.cwd || CONFIG.DEFAULT_CWD,
          SESSION_ISOLATED: this.canIsolate ? '1' : '0',
          COMMAND_TIMEOUT_MS: String(CONFIG.COMMAND_TIMEOUT_MS),
          CLEANUP_INTERVAL_MS: String(CONFIG.CLEANUP_INTERVAL_MS),
          TEMP_FILE_MAX_AGE_MS: String(CONFIG.TEMP_FILE_MAX_AGE_MS),
          TEMP_DIR: CONFIG.TEMP_DIR,
          ...this.options.env
        }
      });
      console.log(`[Session] Control process spawned with PID: ${this.control.pid}`);
    } catch (err) {
      const error = err as Error;
      console.error(`[Session] Failed to spawn control process:`, error);
      throw error;
    }
    
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
      console.error(`[Session] Control stderr for '${this.options.id}': ${data.toString()}`);
    });
    
    this.control.on('error', (error) => {
      console.error(`[Session] Control process error for '${this.options.id}':`, error);
      this.cleanup(error);
    });
    
    this.control.on('exit', (code) => {
      console.log(`[Session] Control process exited for '${this.options.id}' with code ${code}`);
      this.cleanup(new Error(`Control process exited with code ${code}`));
    });
    
    // Wait for ready signal
    await this.waitForReady();
    
    console.log(`[Session] Session '${this.options.id}' initialized successfully`);
  }
  
  
  private waitForReady(): Promise<void> {
    console.log(`[Session] Waiting for control process ready signal (timeout: ${CONFIG.READY_TIMEOUT_MS}ms)`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error(`[Session] Control process ready timeout after ${CONFIG.READY_TIMEOUT_MS}ms`);
        console.error(`[Session] Control process state:`, {
          pid: this.control?.pid,
          killed: this.control?.killed,
          exitCode: this.control?.exitCode,
          signalCode: this.control?.signalCode
        });
        reject(new Error(`Control process initialization timeout after ${CONFIG.READY_TIMEOUT_MS}ms`));
      }, CONFIG.READY_TIMEOUT_MS);
      
      const checkReady = (msg: ControlResponse) => {
        if (msg.type === 'ready' && msg.id === 'init') {
          console.log(`[Session] Received ready signal from control process`);
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
      throw new Error(`Session '${this.options.id}' not initialized`);
    }
    
    // Validate cwd if provided - must be absolute path
    if (options?.cwd) {
      if (!options.cwd.startsWith('/')) {
        throw new Error(`cwd must be an absolute path starting with '/', got: ${options.cwd}`);
      }
    }
    
    const id = randomUUID();
    const startTime = Date.now();
    
    return new Promise<RawExecResult>((resolve, reject) => {
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
    }).then(raw => ({
      ...raw,
      success: raw.exitCode === 0,
      command,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }));
  }

  async *execStream(command: string, options?: { cwd?: string }): AsyncGenerator<ExecEvent> {
    if (!this.ready || !this.control) {
      throw new Error(`Session '${this.options.id}' not initialized`);
    }
    
    // Validate cwd if provided - must be absolute path
    if (options?.cwd) {
      if (!options.cwd.startsWith('/')) {
        throw new Error(`cwd must be an absolute path starting with '/', got: ${options.cwd}`);
      }
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
    // Create parent directory if needed, then write file using heredoc
    // Note: The quoted heredoc delimiter 'SANDBOX_EOF' prevents variable expansion
    // and treats the content literally, so no escaping is required
    const command = `mkdir -p "$(dirname "${path}")" && cat > "${path}" << 'SANDBOX_EOF'
${content}
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
      const match = line.match(/^([-dlrwx]+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\d+\s+[\d:]+)\s+(.+)$/);
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

  // Process Management Methods
  
  async startProcess(command: string, options?: {
    processId?: string;
    timeout?: number;
    env?: Record<string, string>;
    cwd?: string;
    encoding?: string;
    autoCleanup?: boolean;
  }): Promise<ProcessRecord> {
    // Validate cwd if provided - must be absolute path
    if (options?.cwd) {
      if (!options.cwd.startsWith('/')) {
        throw new Error(`cwd must be an absolute path starting with '/', got: ${options.cwd}`);
      }
    }
    
    const processId = options?.processId || `proc_${Date.now()}_${randomBytes(6).toString('hex')}`;
    
    // Check if process ID already exists in this session
    if (this.processes.has(processId)) {
      throw new Error(`Process already exists in session: ${processId}`);
    }
    
    console.log(`[Session ${this.options.id}] Starting process: ${command} (ID: ${processId})`);
    
    // Create separate temp files for stdout and stderr
    const stdoutFile = `/tmp/proc_${processId}.stdout`;
    const stderrFile = `/tmp/proc_${processId}.stderr`;
    
    // Create process record
    const processRecord: ProcessRecord = {
      id: processId,
      command,
      status: 'starting',
      startTime: new Date(),
      stdout: '',
      stderr: '',
      outputListeners: new Set(),
      statusListeners: new Set()
    };
    
    this.processes.set(processId, processRecord);
    
    // Start the process in background with nohup
    // Keep stdout and stderr separate
    const backgroundCommand = `nohup ${command} > ${stdoutFile} 2> ${stderrFile} & echo $!`;
    
    try {
      // Execute the background command and get PID directly
      const result = await this.exec(backgroundCommand, { cwd: options?.cwd });
      const pid = parseInt(result.stdout.trim(), 10);
      
      if (Number.isNaN(pid)) {
        throw new Error(`Failed to get process PID from output: ${result.stdout}`);
      }
      
      processRecord.pid = pid;
      processRecord.status = 'running';
      
      // Store the output file paths for later retrieval
      processRecord.stdoutFile = stdoutFile;
      processRecord.stderrFile = stderrFile;
      
      console.log(`[Session ${this.options.id}] Process ${processId} started with PID ${pid}`);
      
    } catch (error) {
      processRecord.status = 'error';
      processRecord.endTime = new Date();
      processRecord.stderr = `Failed to start process: ${error instanceof Error ? error.message : String(error)}`;
      
      // Notify status listeners
      for (const listener of processRecord.statusListeners) {
        listener('error');
      }
      
      // Clean up temp files
      this.exec(`rm -f ${stdoutFile} ${stderrFile}`).catch(() => {});
      
      throw error;
    }
    
    return processRecord;
  }
  
  // Check and update process status on-demand
  private async updateProcessStatus(processRecord: ProcessRecord): Promise<void> {
    if (!processRecord.pid || processRecord.status !== 'running') {
      return; // Nothing to check
    }
    
    try {
      // Check if process is still running (kill -0 just checks, doesn't actually kill)
      const checkResult = await this.exec(`kill -0 ${processRecord.pid} 2>/dev/null && echo "running" || echo "stopped"`);
      const isRunning = checkResult.stdout.trim() === 'running';
      
      if (!isRunning) {
        // Process has stopped
        processRecord.status = 'completed';
        processRecord.endTime = new Date();
        
        // Try to get exit status from wait (may not work if process already reaped)
        try {
          const waitResult = await this.exec(`wait ${processRecord.pid} 2>/dev/null; echo $?`);
          const exitCode = parseInt(waitResult.stdout.trim(), 10);
          if (!Number.isNaN(exitCode)) {
            processRecord.exitCode = exitCode;
            if (exitCode !== 0) {
              processRecord.status = 'failed';
            }
          }
        } catch {
          // Can't get exit code, that's okay
        }
        
        // Read final output if not already cached
        if ((processRecord.stdoutFile || processRecord.stderrFile) && (!processRecord.stdout && !processRecord.stderr)) {
          await this.updateProcessLogs(processRecord);
        }
        
        // Notify status listeners
        for (const listener of processRecord.statusListeners) {
          listener(processRecord.status);
        }
        
        console.log(`[Session ${this.options.id}] Process ${processRecord.id} completed with status: ${processRecord.status}`);
      }
    } catch (error) {
      console.error(`[Session ${this.options.id}] Error checking process ${processRecord.id} status:`, error);
    }
  }
  
  // Update process logs from output files
  private async updateProcessLogs(processRecord: ProcessRecord): Promise<void> {
    if (!processRecord.stdoutFile && !processRecord.stderrFile) {
      return;
    }
    
    try {
      // Read stdout
      if (processRecord.stdoutFile) {
        const result = await this.exec(`cat ${processRecord.stdoutFile} 2>/dev/null || true`);
        const newStdout = result.stdout;
        
        // Check if there's new stdout
        if (newStdout.length > processRecord.stdout.length) {
          const delta = newStdout.substring(processRecord.stdout.length);
          processRecord.stdout = newStdout;
          
          // Notify output listeners if any
          for (const listener of processRecord.outputListeners) {
            listener('stdout', delta);
          }
        }
      }
      
      // Read stderr
      if (processRecord.stderrFile) {
        const result = await this.exec(`cat ${processRecord.stderrFile} 2>/dev/null || true`);
        const newStderr = result.stdout; // Note: reading stderr file content from result.stdout
        
        // Check if there's new stderr
        if (newStderr.length > processRecord.stderr.length) {
          const delta = newStderr.substring(processRecord.stderr.length);
          processRecord.stderr = newStderr;
          
          // Notify output listeners if any
          for (const listener of processRecord.outputListeners) {
            listener('stderr', delta);
          }
        }
      }
    } catch (error) {
      console.error(`[Session ${this.options.id}] Error reading process ${processRecord.id} logs:`, error);
    }
  }
  
  async getProcess(processId: string): Promise<ProcessRecord | undefined> {
    const process = this.processes.get(processId);
    if (process) {
      // Update status before returning
      await this.updateProcessStatus(process);
    }
    return process;
  }
  
  async listProcesses(): Promise<ProcessRecord[]> {
    const processes = Array.from(this.processes.values());
    
    // Update status for all running processes
    for (const process of processes) {
      if (process.status === 'running') {
        await this.updateProcessStatus(process);
      }
    }
    
    return processes;
  }
  
  async killProcess(processId: string): Promise<boolean> {
    const process = this.processes.get(processId);
    if (!process) {
      return false;
    }
    
    // Stop monitoring first
    this.stopProcessMonitoring(process);
    
    // Only try to kill if process is running
    if (process.pid && (process.status === 'running' || process.status === 'starting')) {
      try {
        // Send SIGTERM to the process
        await this.exec(`kill ${process.pid} 2>/dev/null || true`);
        console.log(`[Session ${this.options.id}] Sent SIGTERM to process ${processId} (PID: ${process.pid})`);
        
        // Give it a moment to terminate gracefully (500ms), then force kill if needed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check if still running and force kill if needed
        const checkResult = await this.exec(`kill -0 ${process.pid} 2>/dev/null && echo "running" || echo "stopped"`);
        if (checkResult.stdout.trim() === 'running') {
          await this.exec(`kill -9 ${process.pid} 2>/dev/null || true`);
          console.log(`[Session ${this.options.id}] Force killed process ${processId} (PID: ${process.pid})`);
        }
      } catch (error) {
        console.error(`[Session ${this.options.id}] Error killing process ${processId}:`, error);
      }
      
      process.status = 'killed';
      process.endTime = new Date();
      
      // Read final output before cleanup
      if (process.stdoutFile || process.stderrFile) {
        await this.updateProcessLogs(process);
      }
      
      // Notify status listeners
      for (const listener of process.statusListeners) {
        listener('killed');
      }
      
      // Clean up temp files
      if (process.stdoutFile || process.stderrFile) {
        this.exec(`rm -f ${process.stdoutFile} ${process.stderrFile}`).catch(() => {});
      }
      
      return true;
    }
    
    // Process not running, just update status
    if (process.status === 'running' || process.status === 'starting') {
      process.status = 'killed';
      process.endTime = new Date();
      
      // Notify status listeners
      for (const listener of process.statusListeners) {
        listener('killed');
      }
    }
    
    return true;
  }
  
  async killAllProcesses(): Promise<number> {
    let killedCount = 0;
    for (const [id, _] of this.processes) {
      if (await this.killProcess(id)) {
        killedCount++;
      }
    }
    return killedCount;
  }
  
  // Get process logs (updates from files if needed)
  async getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string }> {
    const process = this.processes.get(processId);
    if (!process) {
      throw new Error(`Process not found: ${processId}`);
    }
    
    // Update logs from files
    if (process.stdoutFile || process.stderrFile) {
      await this.updateProcessLogs(process);
    }
    
    // Return current logs
    return {
      stdout: process.stdout,
      stderr: process.stderr
    };
  }
  
  // Start monitoring a process for output changes
  startProcessMonitoring(processRecord: ProcessRecord): void {
    // Don't monitor if already monitoring or process not running
    if (processRecord.monitoringInterval || processRecord.status !== 'running') {
      return;
    }
    
    console.log(`[Session ${this.options.id}] Starting monitoring for process ${processRecord.id}`);
    
    // Poll every 100ms for near real-time updates
    processRecord.monitoringInterval = setInterval(async () => {
      // Stop monitoring if no listeners or process not running
      if (processRecord.outputListeners.size === 0 || processRecord.status !== 'running') {
        this.stopProcessMonitoring(processRecord);
        return;
      }
      
      // Update logs from temp files (this will notify listeners if there's new content)
      await this.updateProcessLogs(processRecord);
      
      // Also check if process is still running
      await this.updateProcessStatus(processRecord);
    }, 100);
  }
  
  // Stop monitoring a process
  stopProcessMonitoring(processRecord: ProcessRecord): void {
    if (processRecord.monitoringInterval) {
      console.log(`[Session ${this.options.id}] Stopping monitoring for process ${processRecord.id}`);
      clearInterval(processRecord.monitoringInterval);
      processRecord.monitoringInterval = undefined;
    }
  }

  async destroy(): Promise<void> {
    // Stop all monitoring intervals first
    for (const process of this.processes.values()) {
      this.stopProcessMonitoring(process);
    }
    
    // Kill all processes
    await this.killAllProcesses();
    
    // Clean up all temp files
    for (const [id, process] of this.processes) {
      if (process.stdoutFile || process.stderrFile) {
        await this.exec(`rm -f ${process.stdoutFile} ${process.stderrFile}`).catch(() => {});
      }
    }
    
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
    // Validate cwd if provided - must be absolute path
    if (options.cwd) {
      if (!options.cwd.startsWith('/')) {
        throw new Error(`cwd must be an absolute path starting with '/', got: ${options.cwd}`);
      }
    }
    
    // Clean up existing session with same name
    const existing = this.sessions.get(options.id);
    if (existing) {
      existing.destroy();
    }
    
    // Create new session
    const session = new Session(options);
    await session.initialize();
    
    this.sessions.set(options.id, session);
    console.log(`[SessionManager] Created session '${options.id}'`);
    return session;
  }
  
  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  
  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  // Helper to get or create default session - reduces duplication
  async getOrCreateDefaultSession(): Promise<Session> {
    let defaultSession = this.sessions.get('default');
    if (!defaultSession) {
      defaultSession = await this.createSession({ 
        id: 'default',
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
  
  async destroyAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.destroy();
    }
    this.sessions.clear();
  }
}
