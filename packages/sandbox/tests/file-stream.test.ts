import type { FileMetadata } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import { collectFile, streamFile } from '../src/file-stream';

describe('File Streaming Utilities', () => {
  /**
   * Helper to create a mock SSE stream for testing
   */
  function createMockSSEStream(events: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event));
        }
        controller.close();
      }
    });
  }

  describe('streamFile', () => {
    it('should stream text file chunks and return metadata', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":11,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"chunk","data":"Hello"}\n\n',
        'data: {"type":"chunk","data":" World"}\n\n',
        'data: {"type":"complete","bytesRead":11}\n\n',
      ]);

      const chunks: string[] = [];
      const generator = streamFile(stream);
      let result = await generator.next();

      // Collect chunks
      while (!result.done) {
        chunks.push(result.value as string);
        result = await generator.next();
      }

      // Metadata is the return value
      const metadata = result.value;

      expect(chunks).toEqual(['Hello', ' World']);
      expect(metadata).toEqual({
        mimeType: 'text/plain',
        size: 11,
        isBinary: false,
        encoding: 'utf-8',
      });
    });

    it('should stream binary file with base64 decoding', async () => {
      // Base64 encoded "test" = "dGVzdA=="
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"image/png","size":4,"isBinary":true,"encoding":"base64"}\n\n',
        'data: {"type":"chunk","data":"dGVzdA=="}\n\n',
        'data: {"type":"complete","bytesRead":4}\n\n',
      ]);

      const chunks: (string | Uint8Array)[] = [];
      const generator = streamFile(stream);
      let result = await generator.next();

      // Collect chunks
      while (!result.done) {
        chunks.push(result.value);
        result = await generator.next();
      }

      const metadata = result.value;

      // For binary files, chunks should be Uint8Array
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]).toBeInstanceOf(Uint8Array);

      // Verify we can reconstruct the original data
      const allBytes = new Uint8Array(
        chunks.reduce((acc, chunk) => {
          if (chunk instanceof Uint8Array) {
            return acc + chunk.length;
          }
          return acc;
        }, 0)
      );

      let offset = 0;
      for (const chunk of chunks) {
        if (chunk instanceof Uint8Array) {
          allBytes.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const decoded = new TextDecoder().decode(allBytes);
      expect(decoded).toBe('test');

      expect(metadata?.isBinary).toBe(true);
      expect(metadata?.encoding).toBe('base64');
      expect(metadata?.mimeType).toBe('image/png');
    });

    it('should handle empty files', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":0,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"complete","bytesRead":0}\n\n',
      ]);

      const chunks: string[] = [];
      const generator = streamFile(stream);
      let result = await generator.next();

      while (!result.done) {
        chunks.push(result.value as string);
        result = await generator.next();
      }

      const metadata = result.value;

      expect(chunks).toEqual([]);
      expect(metadata?.size).toBe(0);
    });

    it('should handle error events', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":100,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"chunk","data":"Hello"}\n\n',
        'data: {"type":"error","error":"Read error: Permission denied"}\n\n',
      ]);

      const generator = streamFile(stream);

      try {
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
        // Should have thrown
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('Read error: Permission denied');
      }
    });
  });

  describe('collectFile', () => {
    it('should collect entire text file into string', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":11,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"chunk","data":"Hello"}\n\n',
        'data: {"type":"chunk","data":" World"}\n\n',
        'data: {"type":"complete","bytesRead":11}\n\n',
      ]);

      const result = await collectFile(stream);

      expect(result.content).toBe('Hello World');
      expect(result.metadata).toEqual({
        mimeType: 'text/plain',
        size: 11,
        isBinary: false,
        encoding: 'utf-8',
      });
    });

    it('should collect entire binary file into Uint8Array', async () => {
      // Base64 encoded "test" = "dGVzdA=="
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"image/png","size":4,"isBinary":true,"encoding":"base64"}\n\n',
        'data: {"type":"chunk","data":"dGVzdA=="}\n\n',
        'data: {"type":"complete","bytesRead":4}\n\n',
      ]);

      const result = await collectFile(stream);

      expect(result.content).toBeInstanceOf(Uint8Array);
      expect(result.metadata.isBinary).toBe(true);

      // Decode to verify content
      const decoded = new TextDecoder().decode(result.content as Uint8Array);
      expect(decoded).toBe('test');
    });

    it('should handle empty files', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":0,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"complete","bytesRead":0}\n\n',
      ]);

      const result = await collectFile(stream);

      expect(result.content).toBe('');
      expect(result.metadata.size).toBe(0);
    });

    it('should propagate errors from stream', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":100,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {"type":"chunk","data":"Hello"}\n\n',
        'data: {"type":"error","error":"File not found"}\n\n',
      ]);

      await expect(collectFile(stream)).rejects.toThrow('File not found');
    });

    it('should handle large text files efficiently', async () => {
      // Create a stream with many chunks
      const chunkCount = 100;
      const events = [
        'data: {"type":"metadata","mimeType":"text/plain","size":500,"isBinary":false,"encoding":"utf-8"}\n\n',
      ];

      for (let i = 0; i < chunkCount; i++) {
        events.push(`data: {"type":"chunk","data":"chunk${i}"}\n\n`);
      }

      events.push('data: {"type":"complete","bytesRead":500}\n\n');

      const stream = createMockSSEStream(events);
      const result = await collectFile(stream);

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('chunk0');
      expect(result.content).toContain('chunk99');
      expect(result.metadata.encoding).toBe('utf-8');
    });

    it('should handle large binary files efficiently', async () => {
      // Create a stream with many base64 chunks
      const chunkCount = 100;
      const events = [
        'data: {"type":"metadata","mimeType":"application/octet-stream","size":400,"isBinary":true,"encoding":"base64"}\n\n',
      ];

      for (let i = 0; i < chunkCount; i++) {
        // Each "AAAA" base64 chunk decodes to 3 bytes (0x00, 0x00, 0x00)
        events.push('data: {"type":"chunk","data":"AAAA"}\n\n');
      }

      events.push('data: {"type":"complete","bytesRead":400}\n\n');

      const stream = createMockSSEStream(events);
      const result = await collectFile(stream);

      expect(result.content).toBeInstanceOf(Uint8Array);
      expect((result.content as Uint8Array).length).toBeGreaterThan(0);
      expect(result.metadata.isBinary).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle streams with no metadata event', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"chunk","data":"Hello"}\n\n',
        'data: {"type":"complete","bytesRead":5}\n\n',
      ]);

      // Without metadata, we don't know if it's binary or text
      // The implementation should throw
      const generator = streamFile(stream);

      try {
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
        // Should have thrown
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('Received chunk before metadata');
      }
    });

    it('should handle malformed JSON in SSE events', async () => {
      const stream = createMockSSEStream([
        'data: {"type":"metadata","mimeType":"text/plain","size":5,"isBinary":false,"encoding":"utf-8"}\n\n',
        'data: {invalid json\n\n',
        'data: {"type":"complete","bytesRead":5}\n\n',
      ]);

      // Malformed JSON is logged but doesn't break the stream
      // It should complete successfully but with no chunks
      const result = await collectFile(stream);
      expect(result.content).toBe('');
    });

    it('should handle base64 padding correctly', async () => {
      // Test various base64 strings with different padding
      const testCases = [
        { input: 'YQ==', expected: 'a' },      // 1 byte, 2 padding
        { input: 'YWI=', expected: 'ab' },    // 2 bytes, 1 padding
        { input: 'YWJj', expected: 'abc' },   // 3 bytes, no padding
      ];

      for (const testCase of testCases) {
        const stream = createMockSSEStream([
          `data: {"type":"metadata","mimeType":"application/octet-stream","size":${testCase.expected.length},"isBinary":true,"encoding":"base64"}\n\n`,
          `data: {"type":"chunk","data":"${testCase.input}"}\n\n`,
          `data: {"type":"complete","bytesRead":${testCase.expected.length}}\n\n`,
        ]);

        const result = await collectFile(stream);
        const decoded = new TextDecoder().decode(result.content as Uint8Array);
        expect(decoded).toBe(testCase.expected);
      }
    });
  });
});
