/**
 * Snapshot Client
 *
 * HTTP client for directory snapshot operations (create and apply).
 * Provides async iterables for streaming progress events.
 */

import type {
  ApplySnapshotRequest,
  CreateSnapshotRequest,
  SnapshotEvent
} from '@repo/shared';
import { parseSSEStream } from '../sse-parser';
import { BaseHttpClient } from './base-client';

export class SnapshotClient extends BaseHttpClient {
  /**
   * Create a snapshot of a directory and upload to R2/S3
   *
   * Streams progress events from the container as it:
   * 1. Validates the directory
   * 2. Creates tar archive with zstd compression
   * 3. Uploads to presigned URL
   *
   * @param request - Snapshot creation request
   * @yields SnapshotEvent - Progress events (start, progress, complete, error)
   */
  async *createSnapshot(
    request: CreateSnapshotRequest
  ): AsyncGenerator<SnapshotEvent> {
    this.logger.debug('Creating snapshot', {
      directory: request.directory,
      compressionLevel: request.compressionLevel
    });

    try {
      const stream = await this.doStreamFetch('/api/snapshot/create', request);
      yield* parseSSEStream<SnapshotEvent>(stream);
    } catch (error) {
      this.logError('createSnapshot', error);
      throw error;
    }
  }

  /**
   * Download and apply a snapshot from R2/S3 to a directory
   *
   * Streams progress events from the container as it:
   * 1. Downloads from presigned URL
   * 2. Decompresses with zstd
   * 3. Extracts tar archive to target directory
   *
   * @param request - Snapshot apply request
   * @yields SnapshotEvent - Progress events (start, progress, complete, error)
   */
  async *applySnapshot(
    request: ApplySnapshotRequest
  ): AsyncGenerator<SnapshotEvent> {
    this.logger.debug('Applying snapshot', {
      targetDirectory: request.targetDirectory
    });

    try {
      const stream = await this.doStreamFetch('/api/snapshot/apply', request);
      yield* parseSSEStream<SnapshotEvent>(stream);
    } catch (error) {
      this.logError('applySnapshot', error);
      throw error;
    }
  }
}
