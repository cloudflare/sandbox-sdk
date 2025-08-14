import type { ProcessRecord, ProcessStatus, StartProcessRequest } from "../types";
import type { SessionManager } from "../utils/isolation";

// Process management handlers - all processes are tracked per-session

// Helper types for process responses
interface ProcessInfo {
    id: string;
    pid?: number;
    command: string;
    status: ProcessStatus;
    startTime: string;
    endTime?: string | null;
    exitCode?: number | null;
    sessionName: string;
}

// Helper functions to reduce repetition
function createErrorResponse(
    error: string,
    message?: string,
    status: number = 500,
    corsHeaders: Record<string, string> = {}
): Response {
    return new Response(
        JSON.stringify({
            error,
            ...(message && { message })
        }),
        {
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
            },
            status,
        }
    );
}

function createSuccessResponse(
    data: Record<string, unknown>,
    corsHeaders: Record<string, string> = {}
): Response {
    return new Response(
        JSON.stringify(data),
        {
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
            },
        }
    );
}

function processRecordToInfo(
    record: ProcessRecord,
    sessionName: string
): ProcessInfo {
    return {
        id: record.id,
        pid: record.pid,
        command: record.command,
        status: record.status,
        startTime: record.startTime.toISOString(),
        endTime: record.endTime ? record.endTime.toISOString() : null,
        exitCode: record.exitCode ?? null,
        sessionName
    };
}

async function findProcessAcrossSessions(
    processId: string,
    sessionManager: SessionManager
): Promise<{ process: ProcessRecord; sessionName: string } | null> {
    for (const sessionName of sessionManager.listSessions()) {
        const session = sessionManager.getSession(sessionName);
        if (session) {
            const process = await session.getProcess(processId);
            if (process) {
                return { process, sessionName };
            }
        }
    }
    return null;
}

export async function handleStartProcessRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as StartProcessRequest;
        const { command, sessionName, options = {} } = body;

        if (!command || typeof command !== "string") {
            return createErrorResponse(
                "Command is required and must be a string",
                undefined,
                400,
                corsHeaders
            );
        }

        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required for process management",
                undefined,
                500,
                corsHeaders
            );
        }

        console.log(`[Server] Starting process: ${command}${sessionName ? ` in session: ${sessionName}` : ' (default session)'}`);

        // Get the session (use default if not specified)
        const targetSessionName = sessionName || 'default';
        let session = sessionManager.getSession(targetSessionName);
        
        if (!session) {
            if (targetSessionName === 'default') {
                // Create default session if it doesn't exist
                await sessionManager.createSession({
                    name: 'default',
                    cwd: '/workspace',
                    isolation: true
                });
                session = sessionManager.getSession('default');
            }
            
            if (!session) {
                return createErrorResponse(
                    `Session '${targetSessionName}' not found`,
                    undefined,
                    404,
                    corsHeaders
                );
            }
        }
        
        const processRecord = await session.startProcess(command, options);

        return createSuccessResponse({
            process: processRecordToInfo(processRecord, targetSessionName)
        }, corsHeaders);
    } catch (error) {
        console.error("[Server] Error starting process:", error);
        return createErrorResponse(
            "Failed to start process",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleListProcessesRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        // Get the session name from query params if provided
        const url = new URL(req.url);
        const sessionName = url.searchParams.get('session');
        
        let allProcesses: ProcessInfo[] = [];
        
        if (sessionName) {
            // List processes from specific session
            const session = sessionManager.getSession(sessionName);
            if (!session) {
                return createErrorResponse(
                    `Session '${sessionName}' not found`,
                    undefined,
                    404,
                    corsHeaders
                );
            }
            const processes = await session.listProcesses();
            allProcesses = processes.map(p => processRecordToInfo(p, sessionName));
        } else {
            // List processes from all sessions
            for (const name of sessionManager.listSessions()) {
                const session = sessionManager.getSession(name);
                if (session) {
                    const processes = await session.listProcesses();
                    allProcesses.push(...processes.map(p => processRecordToInfo(p, name)));
                }
            }
        }

        return createSuccessResponse({
            processes: allProcesses,
            count: allProcesses.length,
            timestamp: new Date().toISOString(),
        }, corsHeaders);
    } catch (error) {
        console.error("[Server] Error listing processes:", error);
        return createErrorResponse(
            "Failed to list processes",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleGetProcessRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    processId: string,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        const result = await findProcessAcrossSessions(processId, sessionManager);
        if (!result) {
            return createErrorResponse(
                "Process not found",
                processId,
                404,
                corsHeaders
            );
        }
        
        return createSuccessResponse({
            process: processRecordToInfo(result.process, result.sessionName),
            timestamp: new Date().toISOString(),
        }, corsHeaders);
    } catch (error) {
        console.error("[Server] Error getting process:", error);
        return createErrorResponse(
            "Failed to get process",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleKillProcessRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    processId: string,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        // Search for and kill the process across all sessions
        for (const sessionName of sessionManager.listSessions()) {
            const session = sessionManager.getSession(sessionName);
            if (session) {
                const process = await session.getProcess(processId);
                if (process) {
                    const killed = await session.killProcess(processId);
                    return createSuccessResponse({
                        success: killed,
                        processId,
                        sessionName,
                        message: killed ? `Process ${processId} killed` : `Failed to kill process ${processId}`,
                        timestamp: new Date().toISOString(),
                    }, corsHeaders);
                }
            }
        }
        
        return createErrorResponse(
            "Process not found",
            processId,
            404,
            corsHeaders
        );
    } catch (error) {
        console.error("[Server] Error killing process:", error);
        return createErrorResponse(
            "Failed to kill process",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleKillAllProcessesRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        // Get the session name from query params if provided
        const url = new URL(req.url);
        const sessionName = url.searchParams.get('session');
        
        let killedCount = 0;
        
        if (sessionName) {
            // Kill processes in specific session
            const session = sessionManager.getSession(sessionName);
            if (!session) {
                return createErrorResponse(
                    `Session '${sessionName}' not found`,
                    undefined,
                    404,
                    corsHeaders
                );
            }
            killedCount = await session.killAllProcesses();
        } else {
            // Kill processes in all sessions
            for (const name of sessionManager.listSessions()) {
                const session = sessionManager.getSession(name);
                if (session) {
                    killedCount += await session.killAllProcesses();
                }
            }
        }

        return createSuccessResponse({
            success: true,
            killedCount,
            message: `Killed ${killedCount} process${killedCount !== 1 ? 'es' : ''}`,
            timestamp: new Date().toISOString(),
        }, corsHeaders);
    } catch (error) {
        console.error("[Server] Error killing all processes:", error);
        return createErrorResponse(
            "Failed to kill all processes",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleGetProcessLogsRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    processId: string,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        const result = await findProcessAcrossSessions(processId, sessionManager);
        if (!result) {
            return createErrorResponse(
                "Process not found",
                processId,
                404,
                corsHeaders
            );
        }
        
        return createSuccessResponse({
            logs: {
                stdout: result.process.stdout,
                stderr: result.process.stderr,
            },
            processId,
            sessionName: result.sessionName,
            timestamp: new Date().toISOString(),
        }, corsHeaders);
    } catch (error) {
        console.error("[Server] Error getting process logs:", error);
        return createErrorResponse(
            "Failed to get process logs",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}

export async function handleStreamProcessLogsRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    processId: string,
    sessionManager?: SessionManager
): Promise<Response> {
    try {
        if (!sessionManager) {
            return createErrorResponse(
                "Session manager is required",
                undefined,
                500,
                corsHeaders
            );
        }
        
        const result = await findProcessAcrossSessions(processId, sessionManager);
        if (!result) {
            return createErrorResponse(
                "Process not found",
                processId,
                404,
                corsHeaders
            );
        }

        const { process: targetProcess, sessionName } = result;
        
        // Get the session to start monitoring
        const session = sessionManager.getSession(sessionName);
        if (!session) {
            return createErrorResponse(
                "Session not found",
                sessionName,
                404,
                corsHeaders
            );
        }

        // Store listeners outside the stream for proper cleanup
        let outputListener: ((stream: 'stdout' | 'stderr', data: string) => void) | null = null;
        let statusListener: ((status: ProcessStatus) => void) | null = null;

        // Create a stream that sends updates
        const stream = new ReadableStream({
            start(controller) {
                // Send initial logs
                if (targetProcess.stdout) {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                        type: 'stdout', 
                        data: targetProcess.stdout,
                        processId,
                        sessionName,
                        timestamp: new Date().toISOString()
                    })}\n\n`));
                }
                
                if (targetProcess.stderr) {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                        type: 'stderr', 
                        data: targetProcess.stderr,
                        processId,
                        sessionName,
                        timestamp: new Date().toISOString()
                    })}\n\n`));
                }
                
                // If process is complete, send completion and close
                if (targetProcess.status === 'completed' || targetProcess.status === 'failed' || targetProcess.status === 'killed') {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                        type: 'complete', 
                        status: targetProcess.status,
                        exitCode: targetProcess.exitCode,
                        processId,
                        sessionName,
                        timestamp: new Date().toISOString()
                    })}\n\n`));
                    controller.close();
                    return;
                }
                
                // Set up listeners for live updates
                outputListener = (stream: 'stdout' | 'stderr', data: string) => {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                        type: stream, 
                        data,
                        processId,
                        sessionName,
                        timestamp: new Date().toISOString()
                    })}\n\n`));
                };
                
                statusListener = (status: ProcessStatus) => {
                    if (status === 'completed' || status === 'failed' || status === 'killed') {
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                            type: 'complete', 
                            status,
                            exitCode: targetProcess.exitCode,
                            processId,
                            sessionName,
                            timestamp: new Date().toISOString()
                        })}\n\n`));
                        controller.close();
                    }
                };
                
                targetProcess.outputListeners.add(outputListener);
                targetProcess.statusListeners.add(statusListener);
                
                // Start monitoring the process for output changes
                session.startProcessMonitoring(targetProcess);
            },
            cancel() {
                // Clean up when stream is closed (client disconnects)
                // Remove only this stream's listeners, not all listeners
                if (outputListener) {
                    targetProcess.outputListeners.delete(outputListener);
                }
                if (statusListener) {
                    targetProcess.statusListeners.delete(statusListener);
                }
                
                // Stop monitoring if no more listeners
                if (targetProcess.outputListeners.size === 0) {
                    session.stopProcessMonitoring(targetProcess);
                }
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                ...corsHeaders,
            },
        });
    } catch (error) {
        console.error("[Server] Error streaming process logs:", error);
        return createErrorResponse(
            "Failed to stream process logs",
            error instanceof Error ? error.message : "Unknown error",
            500,
            corsHeaders
        );
    }
}