import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse, parseJsonBody } from '../http';

/**
 * Put an object into R2 bucket
 */
export async function putObject(
  bucket: R2Bucket,
  request: Request
): Promise<Response> {
  try {
    const body = await parseJsonBody(request);
    const { key, content, contentType } = body;

    if (!key || content === undefined) {
      return errorResponse('Key and content are required');
    }

    await bucket.put(key, content, {
      httpMetadata: contentType ? { contentType } : undefined
    });

    return jsonResponse({
      success: true,
      message: 'Object uploaded to R2',
      key
    });
  } catch (error: unknown) {
    console.error('Error putting object to R2:', error);
    return errorResponse(
      `Failed to upload object: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Get an object from R2 bucket
 */
export async function getObject(
  bucket: R2Bucket,
  request: Request
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (!key) {
      return errorResponse('Key parameter is required');
    }

    const object = await bucket.get(key);

    if (!object) {
      return errorResponse('Object not found', 404);
    }

    return jsonResponse({
      success: true,
      key,
      content: await object.text(),
      contentType: object.httpMetadata?.contentType,
      size: object.size
    });
  } catch (error: unknown) {
    console.error('Error getting object from R2:', error);
    return errorResponse(
      `Failed to get object: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * List objects in R2 bucket
 */
export async function listObjects(
  bucket: R2Bucket,
  request: Request
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const prefix = url.searchParams.get('prefix') || undefined;
    const limit = Number.parseInt(url.searchParams.get('limit') || '1000', 10);

    const listed = await bucket.list({ prefix, limit });

    return jsonResponse({
      success: true,
      objects: listed.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString()
      })),
      truncated: listed.truncated
    });
  } catch (error: unknown) {
    console.error('Error listing objects from R2:', error);
    return errorResponse(
      `Failed to list objects: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Delete an object from R2 bucket
 */
export async function deleteObject(
  bucket: R2Bucket,
  request: Request
): Promise<Response> {
  try {
    const body = await parseJsonBody(request);
    const { key } = body;

    if (!key) {
      return errorResponse('Key is required');
    }

    await bucket.delete(key);

    return jsonResponse({
      success: true,
      message: 'Object deleted from R2',
      key
    });
  } catch (error: unknown) {
    console.error('Error deleting object from R2:', error);
    return errorResponse(
      `Failed to delete object: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Mount R2 bucket in sandbox container using s3fs
 */
export async function mountBucket(
  sandbox: Sandbox<unknown>,
  request: Request
): Promise<Response> {
  try {
    const body = await parseJsonBody(request);
    const { bucket, mountPath, options } = body;

    if (!bucket || !mountPath) {
      return errorResponse('Bucket and mountPath are required');
    }

    // Get AWS credentials from environment (should be set in test environment)
    const accessKeyId = options?.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      options?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
    const endpoint = options?.endpoint;

    if (!accessKeyId || !secretAccessKey) {
      return errorResponse('AWS credentials not configured');
    }

    // Create mount point
    await sandbox.exec(`mkdir -p ${mountPath}`);

    // Mount using s3fs (container must have s3fs installed)
    const mountCmd = [
      `echo "${accessKeyId}:${secretAccessKey}" > /tmp/.passwd-s3fs`,
      'chmod 600 /tmp/.passwd-s3fs',
      `s3fs ${bucket} ${mountPath}`,
      `-o passwd_file=/tmp/.passwd-s3fs`,
      `-o url=${endpoint || 'https://s3.amazonaws.com'}`,
      `-o use_path_request_style`,
      `-o allow_other`
    ].join(' ');

    const result = await sandbox.exec(mountCmd);

    if (result.exitCode !== 0) {
      return errorResponse(`Failed to mount bucket: ${result.stderr}`, 500);
    }

    return jsonResponse({
      success: true,
      message: 'Bucket mounted successfully',
      bucket,
      mountPath
    });
  } catch (error: unknown) {
    console.error('Error mounting bucket:', error);
    return errorResponse(
      `Failed to mount bucket: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
