import { describe, expect, it } from 'bun:test';
import {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES
} from '../../src/extensions/protocol';

describe('extension bridge protocol', () => {
  it('rejects frames larger than the maximum size', () => {
    const decoder = new FrameDecoder();
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);

    expect(() => decoder.push(header)).toThrow(/exceeds maximum size/);
  });

  it('rejects malformed frame shapes', () => {
    const decoder = new FrameDecoder();
    const body = Buffer.from(
      JSON.stringify({ t: 'res', id: 1, ok: false }),
      'utf8'
    );
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);

    expect(() => decoder.push(Buffer.concat([header, body]))).toThrow(
      /invalid frame shape/
    );
  });

  it('decodes valid sidecar frames', () => {
    const decoder = new FrameDecoder();

    expect(
      decoder.push(encodeFrame({ t: 'res', id: 1, ok: true, value: 'ok' }))
    ).toEqual([{ t: 'res', id: 1, ok: true, value: 'ok' }]);
  });
});
