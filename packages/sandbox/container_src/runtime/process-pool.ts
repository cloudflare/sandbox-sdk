import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type InterpreterLanguage = "python" | "javascript" | "typescript";

export interface InterpreterProcess {
  id: string;
  language: InterpreterLanguage;
  process: ChildProcess;
  sessionId?: string;
  lastUsed: Date;
  isAvailable: boolean;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  success: boolean;
  executionId: string;
  outputs?: RichOutput[];
  error?: {
    type: string;
    message: string;
    traceback?: string;
  };
}

export interface RichOutput {
  type: "text" | "image" | "jpeg" | "svg" | "html" | "json" | "latex" | "markdown" | "javascript" | "error";
  data: string;
  metadata?: Record<string, unknown>;
}

export interface PoolConfig {
  maxProcesses: number;
  idleTimeout: number; // milliseconds
  minSize: number;
  preWarmScript?: string;
}

export interface ExecutorPoolConfig extends PoolConfig {
  executor: InterpreterLanguage;
}

const DEFAULT_EXECUTOR_CONFIGS: Record<InterpreterLanguage, ExecutorPoolConfig> = {
  python: {
    executor: "python",
    minSize: 3,
    maxProcesses: 15,
    idleTimeout: 5 * 60 * 1000, // 5 minutes
    preWarmScript: `
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import json
print(json.dumps({"status": "pre-warmed"}))
`
  },
  javascript: {
    executor: "javascript",
    minSize: 3,
    maxProcesses: 10,
    idleTimeout: 5 * 60 * 1000,
    preWarmScript: `
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
for(let i = 0; i < 1000; i++) {
  JSON.stringify({x: i, data: Math.random()});
}
console.log(JSON.stringify({"status": "pre-warmed"}));
`
  },
  typescript: {
    executor: "typescript",
    minSize: 3,  
    maxProcesses: 10,
    idleTimeout: 5 * 60 * 1000,
    preWarmScript: `
const { transformSync } = require('esbuild');
const warmupCode = 'interface Test { x: number; } const test: Test = { x: 42 }; test.x';
transformSync(warmupCode, { loader: 'ts', target: 'es2020', format: 'cjs' });
console.log(JSON.stringify({"status": "pre-warmed"}));
`
  }
};

export class ProcessPoolManager {
  private pools: Map<InterpreterLanguage, InterpreterProcess[]> = new Map();
  private poolConfigs: Map<InterpreterLanguage, ExecutorPoolConfig> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(customConfigs: Partial<Record<InterpreterLanguage, Partial<ExecutorPoolConfig>>> = {}) {
    const executorEntries = Object.entries(DEFAULT_EXECUTOR_CONFIGS) as [InterpreterLanguage, ExecutorPoolConfig][];
    
    for (const [executor, defaultConfig] of executorEntries) {
      const userConfig = customConfigs[executor] || {};
      const envMinSize = process.env[`${executor.toUpperCase()}_POOL_MIN_SIZE`];
      const envMaxSize = process.env[`${executor.toUpperCase()}_POOL_MAX_SIZE`];
      
      const config: ExecutorPoolConfig = { 
        ...defaultConfig, 
        ...userConfig,
        // Environment variables override user config override defaults
        minSize: envMinSize ? parseInt(envMinSize) : (userConfig.minSize || defaultConfig.minSize),
        maxProcesses: envMaxSize ? parseInt(envMaxSize) : (userConfig.maxProcesses || defaultConfig.maxProcesses)
      };
      
      this.poolConfigs.set(executor, config);
      this.pools.set(executor, []);
    }

    const pythonConfig = this.poolConfigs.get("python");
    if (pythonConfig) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupIdleProcesses();
      }, pythonConfig.idleTimeout / 2);
    }

    // Start pre-warming in background - don't block constructor
    this.startPreWarming().catch((error) => {
      console.error('[ProcessPool] Pre-warming failed:', error);
    });
  }

  async execute(
    language: InterpreterLanguage,
    code: string,
    sessionId?: string,
    timeout = 30000
  ): Promise<ExecutionResult> {
    const totalStartTime = Date.now();
    const process = await this.getProcess(language, sessionId);
    const processAcquireTime = Date.now() - totalStartTime;
    
    const executionId = randomUUID();

    try {
      const execStartTime = Date.now();
      const result = await this.executeCode(process, code, executionId, timeout);
      const execTime = Date.now() - execStartTime;
      const totalTime = Date.now() - totalStartTime;
      
      console.log(`[ProcessPool] Execution complete - Process acquire: ${processAcquireTime}ms, Code exec: ${execTime}ms, Total: ${totalTime}ms`);
      return result;
    } finally {
      this.releaseProcess(process, sessionId);
    }
  }

  private async getProcess(
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> {
    const pool = this.pools.get(language)!;

    if (sessionId) {
      const existingProcess = pool.find(
        (p) => p.sessionId === sessionId && p.isAvailable
      );
      if (existingProcess) {
        existingProcess.isAvailable = false;
        existingProcess.lastUsed = new Date();
        return existingProcess;
      }
    }

    const availableProcess = pool.find((p) => p.isAvailable && !p.sessionId);
    if (availableProcess) {
      availableProcess.isAvailable = false;
      availableProcess.sessionId = sessionId;
      availableProcess.lastUsed = new Date();
      return availableProcess;
    }

    const config = this.poolConfigs.get(language)!;
    if (pool.length < config.maxProcesses) {
      const newProcess = await this.createProcess(language, sessionId);
      pool.push(newProcess);
      return newProcess;
    }

    return new Promise((resolve) => {
      const checkForAvailable = () => {
        const available = pool.find((p) => p.isAvailable);
        if (available) {
          available.isAvailable = false;
          available.sessionId = sessionId;
          available.lastUsed = new Date();
          resolve(available);
        } else {
          setTimeout(checkForAvailable, 100);
        }
      };
      checkForAvailable();
    });
  }

  private async createProcess(
    language: InterpreterLanguage,
    sessionId?: string
  ): Promise<InterpreterProcess> {
    const startTime = Date.now();
    const id = randomUUID();
    let command: string;
    let args: string[];

    switch (language) {
      case "python":
        command = "python3";
        args = ["-u", "/container-server/runtime/executors/python/ipython_executor.py"];
        break;
      case "javascript":
        command = "node";
        args = ["/container-server/runtime/executors/javascript/node_executor.js"];
        break;
      case "typescript":
        command = "node";
        args = ["/container-server/runtime/executors/typescript/ts_executor.js"];
        break;
    }

    console.log(`[ProcessPool] Spawning ${language} process: ${command} ${args.join(' ')}`);
    
    const childProcess = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        NODE_NO_WARNINGS: "1",
      },
      cwd: "/workspace",
    });

    const interpreterProcess: InterpreterProcess = {
      id,
      language,
      process: childProcess,
      sessionId,
      lastUsed: new Date(),
      isAvailable: false,
    };

    return new Promise((resolve, reject) => {
      let readyBuffer = "";
      let errorBuffer = "";
      
      const timeout = setTimeout(() => {
        childProcess.kill();
        console.error(`[ProcessPool] ${language} executor timeout. stdout: "${readyBuffer}", stderr: "${errorBuffer}"`);
        reject(new Error(`${language} executor failed to start`));
      }, 5000);

      const readyHandler = (data: Buffer) => {
        readyBuffer += data.toString();
        console.log(`[ProcessPool] ${language} stdout:`, data.toString());
        
        if (readyBuffer.includes('"ready"')) {
          clearTimeout(timeout);
          childProcess.stdout?.removeListener("data", readyHandler);
          childProcess.stderr?.removeListener("data", errorHandler);
          const readyTime = Date.now() - startTime;
          console.log(`[ProcessPool] ${language} process ${id} ready in ${readyTime}ms`);
          resolve(interpreterProcess);
        }
      };
      
      const errorHandler = (data: Buffer) => {
        errorBuffer += data.toString();
        console.error(`[ProcessPool] ${language} stderr:`, data.toString());
      };

      childProcess.stdout?.on("data", readyHandler);
      childProcess.stderr?.on("data", errorHandler);
      
      childProcess.once("error", (err) => {
        clearTimeout(timeout);
        console.error(`[ProcessPool] ${language} spawn error:`, err);
        reject(err);
      });
      
      childProcess.once("exit", (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          console.error(`[ProcessPool] ${language} exited with code ${code}`);
          reject(new Error(`${language} executor exited with code ${code}`));
        }
      });
    });
  }

  private async executeCode(
    process: InterpreterProcess,
    code: string,
    executionId: string,
    timeout: number
  ): Promise<ExecutionResult> {
    const request = JSON.stringify({ code, executionId });
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Execution timeout"));
      }, timeout);

      let responseBuffer = "";
      
      const responseHandler = (data: Buffer) => {
        responseBuffer += data.toString();
        
        try {
          const response = JSON.parse(responseBuffer);
          clearTimeout(timer);
          process.process.stdout?.removeListener("data", responseHandler);
          
          resolve({
            stdout: response.stdout || "",
            stderr: response.stderr || "",
            success: response.success !== false,
            executionId,
            outputs: response.outputs || [],
            error: response.error || null,
          });
        } catch (e) {
        }
      };
      
      process.process.stdout?.on("data", responseHandler);
      process.process.stdin?.write(`${request}\n`);
    });
  }

  private releaseProcess(
    process: InterpreterProcess,
    sessionId?: string
  ): void {
    if (!sessionId) {
      process.sessionId = undefined;
      process.isAvailable = true;
    } else {
      process.isAvailable = true;
    }
  }

  private async startPreWarming(): Promise<void> {
    console.log('[ProcessPool] Starting unified pre-warming for all executors...');
    const startTime = Date.now();
    
    const warmupPromises = Array.from(this.poolConfigs.entries()).map(
      async ([executor, config]) => {
        if (config.minSize > 0) {
          await this.preWarmExecutor(executor, config);
        }
      }
    );

    try {
      await Promise.all(warmupPromises);
      const totalTime = Date.now() - startTime;
      console.log(`[ProcessPool] Pre-warming complete for all executors in ${totalTime}ms`);
    } catch (error) {
      console.error('[ProcessPool] Pre-warming failed:', error);
    }
  }

  private async preWarmExecutor(executor: InterpreterLanguage, config: ExecutorPoolConfig): Promise<void> {
    const startTime = Date.now();
    console.log(`[ProcessPool] Pre-warming ${config.minSize} ${executor} processes...`);
    
    const pool = this.pools.get(executor);
    if (!pool) {
      console.error(`[ProcessPool] No pool found for executor: ${executor}`);
      return;
    }
    
    for (let i = 0; i < config.minSize; i++) {
      try {
        const sessionId = `pre-warm-${executor}-${i}-${Date.now()}`;
        const process = await this.createProcess(executor, sessionId);
        
        if (config.preWarmScript) {
          await this.executePreWarmScript(process, config.preWarmScript, executor);
        }
        
        process.isAvailable = true;
        process.sessionId = undefined;
        pool.push(process);
      } catch (error) {
        console.error(`[ProcessPool] Failed to pre-warm ${executor} process ${i}:`, error);
      }
    }
    
    const warmupTime = Date.now() - startTime;
    const actualCount = pool.filter(p => p.isAvailable).length;
    console.log(`[ProcessPool] Pre-warmed ${actualCount}/${config.minSize} ${executor} processes in ${warmupTime}ms`);
  }

  private async executePreWarmScript(
    process: InterpreterProcess, 
    script: string, 
    executor: InterpreterLanguage
  ): Promise<void> {
    try {
      const executionId = `pre-warm-${Date.now()}`;
      const result = await this.executeCode(process, script, executionId, 10000);
      
      if (result.success) {
        console.log(`[ProcessPool] ${executor} pre-warm script executed successfully`);
      } else {
        console.warn(`[ProcessPool] ${executor} pre-warm script failed:`, result.stderr);
      }
    } catch (error) {
      console.warn(`[ProcessPool] ${executor} pre-warm script error:`, error);
    }
  }

  private cleanupIdleProcesses(): void {
    const now = new Date();

    const executors = Array.from(this.pools.keys());
    for (const executor of executors) {
      const pool = this.pools.get(executor);
      const config = this.poolConfigs.get(executor);
      
      if (!pool || !config) {
        continue;
      }

      for (let i = pool.length - 1; i >= 0; i--) {
        const process = pool[i];
        const idleTime = now.getTime() - process.lastUsed.getTime();

        // Only clean up excess processes beyond minimum pool size
        if (process.isAvailable && 
            idleTime > config.idleTimeout && 
            pool.filter(p => p.isAvailable).length > config.minSize) {
          process.process.kill();
          pool.splice(i, 1);
          console.log(`[ProcessPool] Cleaned up idle ${executor} process (${pool.length} remaining)`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const executors = Array.from(this.pools.keys());
    for (const executor of executors) {
      const pool = this.pools.get(executor);
      if (pool) {
        for (const process of pool) {
          process.process.kill();
        }
      }
    }

    this.pools.clear();
  }
}

export const processPool = new ProcessPoolManager();