import type { SessionManager } from "../isolation";
import type {
    DeleteFileRequest,
    ListFilesRequest,
    MkdirRequest,
    MoveFileRequest,
    ReadFileRequest,
    RenameFileRequest,
    WriteFileRequest
} from "../types";

// Common path validation patterns
const DANGEROUS_PATH_PATTERNS = [
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

// Path validation utility
function validatePath(...paths: string[]): string | null {
    for (const path of paths) {
        if (!path || typeof path !== "string") {
            return "Path is required and must be a string";
        }
        
        if (DANGEROUS_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
            return "Dangerous path not allowed";
        }
    }
    return null;
}

// Common error response utility
function createPathErrorResponse(
    error: string,
    corsHeaders: Record<string, string>
): Response {
    return new Response(
        JSON.stringify({ error }),
        {
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
            },
            status: 400,
        }
    );
}

// Common server error response utility
function createServerErrorResponse(
    operation: string,
    error: unknown,
    corsHeaders: Record<string, string>
): Response {
    console.error(`[Server] Error in ${operation}:`, error);
    return new Response(
        JSON.stringify({
            error: `Failed to ${operation.replace('handle', '').replace('Request', '').toLowerCase().replace('file', ' file')}`,
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

export async function handleMkdirRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as MkdirRequest;
        const { path, recursive = false, sessionId } = body;

        // Validate path
        const pathError = validatePath(path);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Creating directory: ${path} (recursive: ${recursive})${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.mkdirOperation(path, recursive)
            : await sessionManager.mkdir(path, recursive);
        
        if (!result) {
            return createServerErrorResponse("handleMkdirRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

        return new Response(
            JSON.stringify({
                exitCode: result.exitCode,
                path,
                recursive,
                stderr: "",
                stdout: "",
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
        return createServerErrorResponse("handleMkdirRequest", error, corsHeaders);
    }
}

export async function handleWriteFileRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as WriteFileRequest;
        const { path, content, encoding = "utf-8", sessionId } = body;

        // Validate path
        const pathError = validatePath(path);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Writing file: ${path} (content length: ${content.length})${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.writeFileOperation(path, content, encoding)
            : await sessionManager.writeFile(path, content, encoding);
        
        if (!result) {
            return createServerErrorResponse("handleWriteFileRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

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
        return createServerErrorResponse("handleWriteFileRequest", error, corsHeaders);
    }
}

export async function handleReadFileRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as ReadFileRequest;
        const { path, encoding = "utf-8", sessionId } = body;

        // Validate path
        const pathError = validatePath(path);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Reading file: ${path}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.readFileOperation(path, encoding)
            : await sessionManager.readFile(path, encoding);
        
        if (!result) {
            return createServerErrorResponse("handleReadFileRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

        return new Response(
            JSON.stringify({
                content: result.content,
                exitCode: result.exitCode,
                path,
                success: result.success,
                timestamp: new Date().toISOString(),
                // New metadata fields for binary file support
                encoding: result.encoding,
                isBinary: result.isBinary,
                mimeType: result.mimeType,
                size: result.size,
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders,
                },
            }
        );
    } catch (error) {
        return createServerErrorResponse("handleReadFileRequest", error, corsHeaders);
    }
}

export async function handleDeleteFileRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as DeleteFileRequest;
        const { path, sessionId } = body;

        // Validate path
        const pathError = validatePath(path);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Deleting file: ${path}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.deleteFileOperation(path)
            : await sessionManager.deleteFile(path);
        
        if (!result) {
            return createServerErrorResponse("handleDeleteFileRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

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
        return createServerErrorResponse("handleDeleteFileRequest", error, corsHeaders);
    }
}

export async function handleRenameFileRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as RenameFileRequest;
        const { oldPath, newPath, sessionId } = body;

        // Validate paths
        const pathError = validatePath(oldPath, newPath);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Renaming file: ${oldPath} -> ${newPath}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.renameFileOperation(oldPath, newPath)
            : await sessionManager.renameFile(oldPath, newPath);
        
        if (!result) {
            return createServerErrorResponse("handleRenameFileRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

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
        return createServerErrorResponse("handleRenameFileRequest", error, corsHeaders);
    }
}

export async function handleMoveFileRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as MoveFileRequest;
        const { sourcePath, destinationPath, sessionId } = body;

        // Validate paths
        const pathError = validatePath(sourcePath, destinationPath);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Moving file: ${sourcePath} -> ${destinationPath}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.moveFileOperation(sourcePath, destinationPath)
            : await sessionManager.moveFile(sourcePath, destinationPath);
        
        if (!result) {
            return createServerErrorResponse("handleMoveFileRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

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
        return createServerErrorResponse("handleMoveFileRequest", error, corsHeaders);
    }
}

export async function handleListFilesRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as ListFilesRequest;
        const { path, options, sessionId } = body;

        // Validate path (note: listFiles allows root directory listing)
        const pathError = validatePath(path);
        if (pathError && pathError !== "Dangerous path not allowed") {
            return createPathErrorResponse(pathError, corsHeaders);
        }
        
        // For listFiles, we allow root directory but still check other dangerous patterns
        if (path !== "/" && DANGEROUS_PATH_PATTERNS.slice(1).some((pattern) => pattern.test(path))) {
            return createPathErrorResponse("Dangerous path not allowed", corsHeaders);
        }

        console.log(`[Server] Listing files in: ${path}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Use specific session if provided, otherwise default session
        const result = sessionId
            ? await sessionManager.getSession(sessionId)?.listFilesOperation(path, options)
            : await sessionManager.listFiles(path, options);
        
        if (!result) {
            return createServerErrorResponse("handleListFilesRequest", new Error(`Session '${sessionId}' not found`), corsHeaders);
        }

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
        return createServerErrorResponse("handleListFilesRequest", error, corsHeaders);
    }
}

export async function handleReadFileStreamRequest(
    req: Request,
    corsHeaders: Record<string, string>,
    sessionManager: SessionManager
): Promise<Response> {
    try {
        const body = (await req.json()) as ReadFileRequest;
        const { path, sessionId } = body;

        // Validate path
        const pathError = validatePath(path);
        if (pathError) {
            return createPathErrorResponse(pathError, corsHeaders);
        }

        console.log(`[Server] Streaming file: ${path}${sessionId ? ` in session: ${sessionId}` : ''}`);

        // Get the appropriate session
        const session = sessionId
            ? sessionManager.getSession(sessionId)
            : await sessionManager.getOrCreateDefaultSession();

        if (!session) {
            return createServerErrorResponse(
                "handleReadFileStreamRequest",
                new Error(`Session '${sessionId}' not found`),
                corsHeaders
            );
        }

        // Create SSE stream
        const stream = await session.readFileStreamOperation(path);

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                ...corsHeaders,
            },
        });
    } catch (error) {
        return createServerErrorResponse("handleReadFileStreamRequest", error, corsHeaders);
    }
}