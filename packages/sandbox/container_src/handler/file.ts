import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
    DeleteFileRequest,
    ListFilesRequest,
    MkdirRequest,
    MoveFileRequest,
    ReadFileRequest,
    RenameFileRequest,
    WriteFileRequest
} from "../types";

function executeMkdir(
    path: string,
    recursive: boolean
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

        let stdout = "";
        let stderr = "";

        mkdirChild.stdout?.on("data", (data) => {
            stdout += data.toString();
        });

        mkdirChild.stderr?.on("data", (data) => {
            stderr += data.toString();
        });

        mkdirChild.on("close", (code) => {
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
            console.error(`[Server] Error creating directory: ${path}`, error);
            reject(error);
        });
    });
}

export async function handleMkdirRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as MkdirRequest;
        const { path, recursive = false } = body;

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

        const result = await executeMkdir(path, recursive);

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
    encoding: string
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
        const { path, content, encoding = "utf-8" } = body;

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

        const result = await executeWriteFile(path, content, encoding);

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
    encoding: string
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
        const { path, encoding = "utf-8" } = body;

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

        const result = await executeReadFile(path, encoding);

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
  path: string
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
        const { path } = body;

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

        const result = await executeDeleteFile(path);

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
  newPath: string
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
        const { oldPath, newPath } = body;

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

        const result = await executeRenameFile(oldPath, newPath);

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
  destinationPath: string
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
        const { sourcePath, destinationPath } = body;

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
            destinationPath
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


async function executeListFiles(
    path: string,
    options?: {
        recursive?: boolean;
        includeHidden?: boolean;
    }
): Promise<{
    success: boolean;
    exitCode: number;
    files: Array<{
        name: string;
        absolutePath: string;
        relativePath: string;
        type: 'file' | 'directory' | 'symlink' | 'other';
        size: number;
        modifiedAt: string;
        mode: string;
        permissions: {
            readable: boolean;
            writable: boolean;
            executable: boolean;
        };
    }>;
}> {
    try {
        const basePath = path.endsWith('/') ? path.slice(0, -1) : path;
        const files: Array<{
            name: string;
            absolutePath: string;
            relativePath: string;
            type: 'file' | 'directory' | 'symlink' | 'other';
            size: number;
            modifiedAt: string;
            mode: string;
            permissions: {
                readable: boolean;
                writable: boolean;
                executable: boolean;
            };
        }> = [];

        // Helper function to convert numeric mode to string like "rwxr-xr-x"
        function modeToString(mode: number): string {
            const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];
            const user = (mode >> 6) & 7;
            const group = (mode >> 3) & 7;
            const other = mode & 7;
            return perms[user] + perms[group] + perms[other];
        }

        // Helper function to extract permission booleans for current user
        function getPermissions(mode: number): { readable: boolean; writable: boolean; executable: boolean } {
            // Extract user permissions (owner permissions)
            const userPerms = (mode >> 6) & 7;
            return {
                readable: (userPerms & 4) !== 0,
                writable: (userPerms & 2) !== 0,
                executable: (userPerms & 1) !== 0
            };
        }

        async function scanDirectory(dirPath: string): Promise<void> {
            const entries = await readdir(dirPath);
            
            for (const entry of entries) {
                // Skip hidden files unless includeHidden is true
                if (!options?.includeHidden && entry.startsWith('.')) {
                    continue;
                }

                const fullPath = join(dirPath, entry);
                const stats = await stat(fullPath);
                
                let type: 'file' | 'directory' | 'symlink' | 'other';
                if (stats.isDirectory()) {
                    type = 'directory';
                } else if (stats.isFile()) {
                    type = 'file';
                } else if (stats.isSymbolicLink()) {
                    type = 'symlink';
                } else {
                    type = 'other';
                }

                // Extract mode (permissions) - stats.mode is a number
                const mode = stats.mode & 0o777; // Get only permission bits

                // Calculate relative path from base directory
                const relativePath = fullPath.startsWith(`${basePath}/`)
                    ? fullPath.substring(basePath.length + 1)
                    : fullPath === basePath
                        ? '.'
                        : entry;

                const fileInfo = {
                    name: entry,
                    absolutePath: fullPath,
                    relativePath,
                    type,
                    size: stats.size,
                    modifiedAt: stats.mtime.toISOString(),
                    mode: modeToString(mode),
                    permissions: getPermissions(mode)
                };

                files.push(fileInfo);

                // Recursively scan subdirectories if requested
                if (options?.recursive && type === 'directory') {
                    await scanDirectory(fullPath);
                }
            }
        }

        await scanDirectory(path);

        console.log(`[Server] Listed ${files.length} files in: ${path}`);
        return {
            exitCode: 0,
            files,
            success: true,
        };
    } catch (error) {
        console.error(`[Server] Error listing files in: ${path}`, error);
        throw error;
    }
}

export async function handleListFilesRequest(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<Response> {
    try {
        const body = (await req.json()) as ListFilesRequest;
        const { path, options } = body;

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

        console.log(`[Server] Listing files in: ${path}`);

        const result = await executeListFiles(path, options);

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                files: result.files,
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
        console.error("[Server] Error in handleListFilesRequest:", error);
        return new Response(
            JSON.stringify({
                error: "Failed to list files",
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

