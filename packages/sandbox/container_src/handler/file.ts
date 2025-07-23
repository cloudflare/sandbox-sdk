import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
    DeleteFileRequest,
    MkdirRequest,
    MoveFileRequest,
    ReadFileRequest,
    RenameFileRequest,
    SessionData,
    WriteFileRequest
} from "../types";

function executeMkdir(
    sessions: Map<string, SessionData>,
    path: string,
    recursive: boolean,
    sessionId?: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    return new Promise((resolve, reject) => {
        const args = `${recursive ? "-p " : ""} ${path}`;
        const mkdirChild = spawn(`mkdir ${args}`, {
            shell: true,
            stdio: ["pipe", "pipe", "pipe"],
        });

        // Store the process reference for cleanup if sessionId is provided
        if (sessionId && sessions.has(sessionId)) {
            const session = sessions.get(sessionId)!;
            session.activeProcess = mkdirChild;
        }

        let stdout = "";
        let stderr = "";

        mkdirChild.stdout?.on("data", (data) => {
            stdout += data.toString();
        });

        mkdirChild.stderr?.on("data", (data) => {
            stderr += data.toString();
        });

        mkdirChild.on("close", (code) => {
            // Clear the active process reference
            if (sessionId && sessions.has(sessionId)) {
                const session = sessions.get(sessionId)!;
                session.activeProcess = null;
            }

            if (code === 0) {
                console.log(`[Server] Directory created successfully: ${path}`);
                resolve({
                    exitCode: code || 0,
                    stderr,
                    stdout,
                    success: true,
                });
            } else {
                console.error(
                    `[Server] Failed to create directory: ${path}, Exit code: ${code}`
                );
                resolve({
                    exitCode: code || 1,
                    stderr,
                    stdout,
                    success: false,
                });
            }
        });

        mkdirChild.on("error", (error) => {
            // Clear the active process reference
            if (sessionId && sessions.has(sessionId)) {
                const session = sessions.get(sessionId)!;
                session.activeProcess = null;
            }

            console.error(`[Server] Error creating directory: ${path}`, error);
            reject(error);
        });
    });
}

export async function handleMkdirRequest(
    sessions: Map<string, SessionData>,
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as MkdirRequest;
        const { path, recursive = false, sessionId } = body;

        if (!path || typeof path !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (dangerousPatterns.some((pattern) => pattern.test(path))) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(
            `[Server] Creating directory: ${path} (recursive: ${recursive})`
        );

        const result = await executeMkdir(sessions, path, recursive, sessionId);

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                path,
                recursive,
                stderr: result.stderr,
                stdout: result.stdout,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleMkdirRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to create directory",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}


function executeWriteFile(
    path: string,
    content: string,
    encoding: string,
    sessionId?: string
): Promise<{
    success: boolean;
    exitCode: number;
}> {
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                // Ensure the directory exists
                const dir = dirname(path);
                if (dir !== ".") {
                    await mkdir(dir, { recursive: true });
                }

                // Write the file
                await writeFile(path, content, {
                    encoding: encoding as BufferEncoding,
                });

                console.log(`[Server] File written successfully: ${path}`);
                resolve({
                    exitCode: 0,
                    success: true,
                });
            } catch (error) {
                console.error(`[Server] Error writing file: ${path}`, error);
                reject(error);
            }
        })();
    });
}

export async function handleWriteFileRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as WriteFileRequest;
        const { path, content, encoding = "utf-8", sessionId } = body;

        if (!path || typeof path !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (dangerousPatterns.some((pattern) => pattern.test(path))) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(
            `[Server] Writing file: ${path} (content length: ${content.length})`
        );

        const result = await executeWriteFile(path, content, encoding, sessionId);

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                path,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleWriteFileRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to write file",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}


function executeReadFile(
    path: string,
    encoding: string,
    sessionId?: string
): Promise<{
    success: boolean;
    exitCode: number;
    content: string;
}> {
    return new Promise((resolve, reject) => {
        (async () => {
            try {
                // Read the file
                const content = await readFile(path, {
                    encoding: encoding as BufferEncoding,
                });

                console.log(`[Server] File read successfully: ${path}`);
                resolve({
                    content,
                    exitCode: 0,
                    success: true,
                });
            } catch (error) {
                console.error(`[Server] Error reading file: ${path}`, error);
                reject(error);
            }
        })();
    });
}

export async function handleReadFileRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as ReadFileRequest;
        const { path, encoding = "utf-8", sessionId } = body;

        if (!path || typeof path !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (dangerousPatterns.some((pattern) => pattern.test(path))) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(`[Server] Reading file: ${path}`);

        const result = await executeReadFile(path, encoding, sessionId);

        return new Response(
            JSON.stringify({
                content: result.content,
                exitCode: result.exitCode,
                path,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleReadFileRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to read file",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}


function executeDeleteFile(
  path: string,
  sessionId?: string
): Promise<{
  success: boolean;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        // Delete the file
        await unlink(path);

        console.log(`[Server] File deleted successfully: ${path}`);
        resolve({
          exitCode: 0,
          success: true,
        });
      } catch (error) {
        console.error(`[Server] Error deleting file: ${path}`, error);
        reject(error);
      }
    })();
  });
}

export async function handleDeleteFileRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as DeleteFileRequest;
        const { path, sessionId } = body;

        if (!path || typeof path !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (dangerousPatterns.some((pattern) => pattern.test(path))) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(`[Server] Deleting file: ${path}`);

        const result = await executeDeleteFile(path, sessionId);

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                path,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleDeleteFileRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to delete file",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}


function executeRenameFile(
  oldPath: string,
  newPath: string,
  sessionId?: string
): Promise<{
  success: boolean;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        // Rename the file
        await rename(oldPath, newPath);

        console.log(
          `[Server] File renamed successfully: ${oldPath} -> ${newPath}`
        );
        resolve({
          exitCode: 0,
          success: true,
        });
      } catch (error) {
        console.error(
          `[Server] Error renaming file: ${oldPath} -> ${newPath}`,
          error
        );
        reject(error);
      }
    })();
  });
}

export async function handleRenameFileRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as RenameFileRequest;
        const { oldPath, newPath, sessionId } = body;

        if (!oldPath || typeof oldPath !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Old path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        if (!newPath || typeof newPath !== "string") {
            return new Response(
                JSON.stringify({
                    error: "New path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (
            dangerousPatterns.some(
                (pattern) => pattern.test(oldPath) || pattern.test(newPath)
            )
        ) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(`[Server] Renaming file: ${oldPath} -> ${newPath}`);

        const result = await executeRenameFile(oldPath, newPath, sessionId);

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                newPath,
                oldPath,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleRenameFileRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to rename file",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}


function executeMoveFile(
  sourcePath: string,
  destinationPath: string,
  sessionId?: string
): Promise<{
  success: boolean;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        // Move the file
        await rename(sourcePath, destinationPath);

        console.log(
          `[Server] File moved successfully: ${sourcePath} -> ${destinationPath}`
        );
        resolve({
          exitCode: 0,
          success: true,
        });
      } catch (error) {
        console.error(
          `[Server] Error moving file: ${sourcePath} -> ${destinationPath}`,
          error
        );
        reject(error);
      }
    })();
  });
}

export async function handleMoveFileRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as MoveFileRequest;
        const { sourcePath, destinationPath, sessionId } = body;

        if (!sourcePath || typeof sourcePath !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Source path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        if (!destinationPath || typeof destinationPath !== "string") {
            return new Response(
                JSON.stringify({
                    error: "Destination path is required and must be a string",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        // Basic safety check - prevent dangerous paths
        const dangerousPatterns = [
            /^\/$/, // Root directory
            /^\/etc/, // System directories
            /^\/var/, // System directories
            /^\/usr/, // System directories
            /^\/bin/, // System directories
            /^\/sbin/, // System directories
            /^\/boot/, // System directories
            /^\/dev/, // System directories
            /^\/proc/, // System directories
            /^\/sys/, // System directories
            /^\/tmp\/\.\./, // Path traversal attempts
            /\.\./, // Path traversal attempts
        ];

        if (
            dangerousPatterns.some(
                (pattern) => pattern.test(sourcePath) || pattern.test(destinationPath)
            )
        ) {
            return new Response(
                JSON.stringify({
                    error: "Dangerous path not allowed",
                }),
                {
                    headers: {
                        "Content-Type": "application/json",
                        ...corsHeaders,
                    },
                    status: 400,
                }
            );
        }

        console.log(`[Server] Moving file: ${sourcePath} -> ${destinationPath}`);

        const result = await executeMoveFile(
            sourcePath,
            destinationPath,
            sessionId
        );

        return new Response(
            JSON.stringify({
                destinationPath,
                exitCode: result.exitCode,
                sourcePath,
                success: result.success,
                timestamp: new Date().toISOString(),
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        console.error("[Server] Error in handleMoveFileRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to move file",
                message: error instanceof Error ? error.message : "Unknown error",
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
                status: 500,
            }
        );
    }
}

