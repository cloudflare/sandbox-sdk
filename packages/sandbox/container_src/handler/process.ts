import { type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  ProcessRecord,
  ProcessStatus,
  StartProcessRequest
} from "../types";

// Generate a unique process ID using cryptographically secure randomness
function generateProcessId(): string {
  return `proc_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

// Process management handlers
export async function handleStartProcessRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = (await req.json()) as StartProcessRequest;
    const { command, options = {} } = body;

    if (!command || typeof command !== "string") {
      return new Response(
        JSON.stringify({
          error: "Command is required and must be a string"
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 400
        }
      );
    }

    const processId = options.processId || generateProcessId();
    const startTime = new Date();

    // Check if process ID already exists
    if (processes.has(processId)) {
      return new Response(
        JSON.stringify({
          error: `Process already exists: ${processId}`
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 409
        }
      );
    }

    console.log(
      `[Server] Starting background process: ${command} (ID: ${processId})`
    );

    // Create process record in starting state
    const processRecord: ProcessRecord = {
      id: processId,
      command,
      status: "starting",
      startTime,
      sessionId: options.sessionId,
      stdout: "",
      stderr: "",
      outputListeners: new Set(),
      statusListeners: new Set()
    };

    processes.set(processId, processRecord);

    // Start the actual process
    try {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        detached: false,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"] as const
      };

      // Use shell execution to preserve quotes and complex command structures
      const childProcess = spawn(command, spawnOptions);
      processRecord.childProcess = childProcess;
      processRecord.pid = childProcess.pid;
      processRecord.status = "running";

      // Set up output handling
      childProcess.stdout?.on("data", (data) => {
        const output = data.toString(options.encoding || "utf8");
        processRecord.stdout += output;

        // Notify listeners
        for (const listener of processRecord.outputListeners) {
          listener("stdout", output);
        }
      });

      childProcess.stderr?.on("data", (data) => {
        const output = data.toString(options.encoding || "utf8");
        processRecord.stderr += output;

        // Notify listeners
        for (const listener of processRecord.outputListeners) {
          listener("stderr", output);
        }
      });

      childProcess.on("exit", (code, signal) => {
        processRecord.endTime = new Date();
        processRecord.exitCode = code !== null ? code : -1;

        if (signal) {
          processRecord.status = "killed";
        } else if (code === 0) {
          processRecord.status = "completed";
        } else {
          processRecord.status = "failed";
        }

        // Notify status listeners
        for (const listener of processRecord.statusListeners) {
          listener(processRecord.status);
        }

        console.log(
          `[Server] Process ${processId} exited with code ${code} (signal: ${signal})`
        );
      });

      childProcess.on("error", (error) => {
        processRecord.status = "error";
        processRecord.endTime = new Date();
        console.error(`[Server] Process ${processId} error:`, error);

        // Notify status listeners
        for (const listener of processRecord.statusListeners) {
          listener("error");
        }
      });

      // Timeout handling
      if (options.timeout) {
        setTimeout(() => {
          if (processRecord.status === "running") {
            childProcess.kill("SIGTERM");
            console.log(
              `[Server] Process ${processId} timed out after ${options.timeout}ms`
            );
          }
        }, options.timeout);
      }

      return new Response(
        JSON.stringify({
          process: {
            id: processRecord.id,
            pid: processRecord.pid,
            command: processRecord.command,
            status: processRecord.status,
            startTime: processRecord.startTime.toISOString(),
            sessionId: processRecord.sessionId
          }
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        }
      );
    } catch (error) {
      // Clean up on error
      processes.delete(processId);
      throw error;
    }
  } catch (error) {
    console.error("[Server] Error in handleStartProcessRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to start process",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleListProcessesRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const processesArray = Array.from(processes.values()).map((record) => ({
      id: record.id,
      pid: record.pid,
      command: record.command,
      status: record.status,
      startTime: record.startTime.toISOString(),
      endTime: record.endTime?.toISOString(),
      exitCode: record.exitCode,
      sessionId: record.sessionId
    }));

    return new Response(
      JSON.stringify({
        processes: processesArray,
        count: processesArray.length,
        timestamp: new Date().toISOString()
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleListProcessesRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to list processes",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleGetProcessRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>,
  processId: string
): Promise<Response> {
  try {
    const record = processes.get(processId);

    if (!record) {
      return new Response(
        JSON.stringify({
          process: null
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 404
        }
      );
    }

    return new Response(
      JSON.stringify({
        process: {
          id: record.id,
          pid: record.pid,
          command: record.command,
          status: record.status,
          startTime: record.startTime.toISOString(),
          endTime: record.endTime?.toISOString(),
          exitCode: record.exitCode,
          sessionId: record.sessionId
        }
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleGetProcessRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to get process",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleKillProcessRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>,
  processId: string
): Promise<Response> {
  try {
    const record = processes.get(processId);

    if (!record) {
      return new Response(
        JSON.stringify({
          error: `Process not found: ${processId}`
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 404
        }
      );
    }

    if (record.childProcess && record.status === "running") {
      record.childProcess.kill("SIGTERM");
      console.log(`[Server] Sent SIGTERM to process ${processId}`);

      // Give it a moment to terminate gracefully, then force kill
      setTimeout(() => {
        if (record.childProcess && record.status === "running") {
          record.childProcess.kill("SIGKILL");
          console.log(`[Server] Force killed process ${processId}`);
        }
      }, 5000);
    }

    // Mark as killed locally
    record.status = "killed";
    record.endTime = new Date();
    record.exitCode = -1;

    // Notify status listeners
    for (const listener of record.statusListeners) {
      listener("killed");
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Process ${processId} killed`,
        timestamp: new Date().toISOString()
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleKillProcessRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to kill process",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleKillAllProcessesRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    let killedCount = 0;

    for (const [processId, record] of processes) {
      if (record.childProcess && record.status === "running") {
        try {
          record.childProcess.kill("SIGTERM");
          record.status = "killed";
          record.endTime = new Date();
          record.exitCode = -1;

          // Notify status listeners
          for (const listener of record.statusListeners) {
            listener("killed");
          }

          killedCount++;
          console.log(`[Server] Killed process ${processId}`);
        } catch (error) {
          console.error(`[Server] Failed to kill process ${processId}:`, error);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        killedCount,
        message: `Killed ${killedCount} processes`,
        timestamp: new Date().toISOString()
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleKillAllProcessesRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to kill all processes",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleGetProcessLogsRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>,
  processId: string
): Promise<Response> {
  try {
    const record = processes.get(processId);

    if (!record) {
      return new Response(
        JSON.stringify({
          error: `Process not found: ${processId}`
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 404
        }
      );
    }

    return new Response(
      JSON.stringify({
        stdout: record.stdout,
        stderr: record.stderr,
        processId: record.id
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    console.error("[Server] Error in handleGetProcessLogsRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to get process logs",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}

export async function handleStreamProcessLogsRequest(
  processes: Map<string, ProcessRecord>,
  req: Request,
  corsHeaders: Record<string, string>,
  processId: string
): Promise<Response> {
  try {
    const record = processes.get(processId);

    if (!record) {
      return new Response(
        JSON.stringify({
          error: `Process not found: ${processId}`
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          },
          status: 404
        }
      );
    }

    // Create a readable stream for Server-Sent Events
    let isConnected = true;

    const stream = new ReadableStream({
      start(controller) {
        // Send existing logs first
        if (record.stdout) {
          const event = `data: ${JSON.stringify({
            type: "stdout",
            timestamp: new Date().toISOString(),
            data: record.stdout,
            processId,
            sessionId: record.sessionId
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(event));
        }

        if (record.stderr) {
          const event = `data: ${JSON.stringify({
            type: "stderr",
            timestamp: new Date().toISOString(),
            data: record.stderr,
            processId,
            sessionId: record.sessionId
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(event));
        }

        // Send status
        const statusEvent = `data: ${JSON.stringify({
          type: "status",
          timestamp: new Date().toISOString(),
          data: `Process status: ${record.status}`,
          processId,
          sessionId: record.sessionId
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(statusEvent));

        // Set up real-time streaming for ongoing output
        const outputListener = (stream: "stdout" | "stderr", data: string) => {
          if (!isConnected) return;

          const event = `data: ${JSON.stringify({
            type: stream,
            timestamp: new Date().toISOString(),
            data,
            processId,
            sessionId: record.sessionId
          })}\n\n`;

          try {
            controller.enqueue(new TextEncoder().encode(event));
          } catch (error) {
            console.log(`[Server] Stream closed for process ${processId}`);
            isConnected = false;
          }
        };

        const statusListener = (status: ProcessStatus) => {
          if (!isConnected) return;

          const event = `data: ${JSON.stringify({
            type: "status",
            timestamp: new Date().toISOString(),
            data: `Process status: ${status}`,
            processId,
            sessionId: record.sessionId
          })}\n\n`;

          try {
            controller.enqueue(new TextEncoder().encode(event));
          } catch (error) {
            console.log(`[Server] Stream closed for process ${processId}`);
            isConnected = false;
          }

          // Close stream when process completes
          if (["completed", "failed", "killed", "error"].includes(status)) {
            setTimeout(() => {
              record.outputListeners.delete(outputListener);
              record.statusListeners.delete(statusListener);
              controller.close();
            }, 1000); // Give a moment for final events
          }
        };

        // Add listeners
        record.outputListeners.add(outputListener);
        record.statusListeners.add(statusListener);
      },

      cancel() {
        isConnected = false;
        console.log(`[Server] Log stream cancelled for process ${processId}`);
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders
      }
    });
  } catch (error) {
    console.error("[Server] Error in handleStreamProcessLogsRequest:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to stream process logs",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        },
        status: 500
      }
    );
  }
}
