import { describe, expect, it } from 'bun:test';
import { ByteRingBuffer } from '../../src/utils/ring-buffer';

describe('ByteRingBuffer', () => {
  it('should create buffer with specified capacity', () => {
    const buffer = new ByteRingBuffer(1024);
    expect(buffer.maxSize).toBe(1024);
    expect(buffer.length).toBe(0);
  });

  it('should throw on invalid capacity', () => {
    expect(() => new ByteRingBuffer(0)).toThrow();
    expect(() => new ByteRingBuffer(-1)).toThrow();
    expect(() => new ByteRingBuffer(1.5)).toThrow();
  });

  it('should write and read small data', () => {
    const buffer = new ByteRingBuffer(100);
    const data = new Uint8Array([1, 2, 3, 4, 5]);

    buffer.write(data);
    expect(buffer.length).toBe(5);

    const result = buffer.readAll();
    expect(result).toEqual(data);
  });

  it('should handle wrap-around correctly', () => {
    const buffer = new ByteRingBuffer(10);

    buffer.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(buffer.length).toBe(8);

    buffer.write(new Uint8Array([9, 10, 11, 12, 13]));
    expect(buffer.length).toBe(10);

    const result = buffer.readAll();
    expect(result).toEqual(new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
  });

  it('should handle data larger than capacity', () => {
    const buffer = new ByteRingBuffer(5);

    buffer.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(buffer.length).toBe(5);

    const result = buffer.readAll();
    expect(result).toEqual(new Uint8Array([4, 5, 6, 7, 8]));
  });

  it('should clear buffer', () => {
    const buffer = new ByteRingBuffer(100);
    buffer.write(new Uint8Array([1, 2, 3]));
    expect(buffer.length).toBe(3);

    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.readAll()).toEqual(new Uint8Array(0));
  });

  it('should not modify buffer on readAll', () => {
    const buffer = new ByteRingBuffer(100);
    buffer.write(new Uint8Array([1, 2, 3]));

    buffer.readAll();
    expect(buffer.length).toBe(3);

    const secondRead = buffer.readAll();
    expect(secondRead).toEqual(new Uint8Array([1, 2, 3]));
  });
});
