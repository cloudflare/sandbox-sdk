import type { ProcessRecord, ProcessStatus, StartProcessRequest } from "../types";
import type { Session, SessionManager } from "../utils/isolation";

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
    sessionId: string;
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
    sessionId: string
): ProcessInfo {
    return {
        id: record.id,
        pid: record.pid,
        command: record.command,
        status: record.status,
        startTime: record.startTime.toISOString(),
        endTime: record.endTime ? record.endTime.toISOString() : null,
        exitCode: record.exitCode ?? null,
        sessionId
    };
}

async function findProcessAcrossSessions(
    processId: string,
    sessionManager: SessionManager
): Promise<{ process: ProcessRecord; sessionId: string } | null> {
    for (const sessionId of sessionManager.listSessions()) {
        const session = sessionManager.getSession(sessionId);
        if (session) {
            const process = await session.getProcess(processId);
            if (process) {
                return { process, sessionId };
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
        const { command, sessionId, options = {} } = body;

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

        console.log(`[Server] Starting process: ${command}${sessionId ? ` in session: ${sessionId}` : ' (default session)'}`);

        // Get the session (use default if not specified)
        let session: Session;
        
        if (sessionId) {
            const specificSession = sessionManager.getSession(sessionId);
            if (!specificSession) {
                return createErrorResponse(
                    `Session '${sessionId}' not found`,
                    undefined,
                    404,
                    corsHeaders
                );
            }
            session = specificSession;
        } else {
            // Use the centralized method to get or create default session
            session = await sessionManager.getOrCreateDefaultSession();
        }
        
        const processRecord = await session.startProcess(command, options);

        return createSuccessResponse({
            process: processRecordToInfo(processRecord, sessionId || 'default')
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
        const sessionId = url.searchParams.get('session');
        
        let allProcesses: ProcessInfo[] = [];
        
        if (sessionId) {
            // List processes from specific session
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                return createErrorResponse(
                    `Session '${sessionId}' not found`,
                    undefined,
                    404,
                    corsHeaders
                );
            }
            const processes = await session.listProcesses();
            allProcesses = processes.map(p => processRecordToInfo(p, sessionId));
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
            process: processRecordToInfo(result.process, result.sessionId),
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
        for (const sessionId of sessionManager.listSessions()) {
            const session = sessionManager.getSession(sessionId);
            if (session) {
                const process = await session.getProcess(processId);
                if (process) {
                    const killed = await session.killProcess(processId);
                    return createSuccessResponse({
                        success: killed,
                        processId,
                        sessionId,
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
        const sessionId = url.searchParams.get('session');
        
        let killedCount = 0;
        
        if (sessionId) {
            // Kill processes in specific session
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                return createErrorResponse(
                    `Session '${sessionId}' not found`,
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
        
        // Get the session and use its getProcessLogs method to ensure logs are updated from files
        const session = sessionManager.getSession(result.sessionId);
        if (!session) {
            return createErrorResponse(
                "Session not found",
                result.sessionId,
                500,
                corsHeaders
            );
        }
        
        // This will update logs from temp files before returning
        const logs = await session.getProcessLogs(processId);
        
        return createSuccessResponse({
            stdout: logs.stdout,
            stderr: logs.stderr,
            processId,
            sessionId: result.sessionId,
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

        const { process: targetProcess, sessionId } = result;
        
        // Get the session to start monitoring
        const session = sessionManager.getSession(sessionId);
        if (!session) {
            return createErrorResponse(
                "Session not found",
                sessionId,
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
                        sessionId,
                        timestamp: new Date().toISOString()
                    })}\n\n`));
                }
                
                if (targetProcess.stderr) {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ 
                        type: 'stderr', 
                        data: targetProcess.stderr,
                        processId,
                        sessionId,
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
                        sessionId,
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
                        sessionId,
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
                            sessionId,
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