export class ByteRingBuffer {
  private buffer: Uint8Array;
  private writePos = 0;
  private size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('Capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.buffer = new Uint8Array(capacity);
  }

  write(data: Uint8Array): void {
    const dataLen = data.length;

    if (dataLen >= this.capacity) {
      this.buffer.set(data.subarray(dataLen - this.capacity));
      this.writePos = 0;
      this.size = this.capacity;
      return;
    }

    const spaceToEnd = this.capacity - this.writePos;

    if (dataLen <= spaceToEnd) {
      this.buffer.set(data, this.writePos);
      this.writePos += dataLen;
    } else {
      this.buffer.set(data.subarray(0, spaceToEnd), this.writePos);
      this.buffer.set(data.subarray(spaceToEnd), 0);
      this.writePos = dataLen - spaceToEnd;
    }

    this.size = Math.min(this.size + dataLen, this.capacity);

    if (this.writePos === this.capacity) {
      this.writePos = 0;
    }
  }

  readAll(): Uint8Array {
    if (this.size === 0) {
      return new Uint8Array(0);
    }

    if (this.size < this.capacity) {
      return this.buffer.slice(0, this.writePos);
    }

    const result = new Uint8Array(this.capacity);
    const oldestPos = this.writePos;
    const firstChunkLen = this.capacity - oldestPos;

    result.set(this.buffer.subarray(oldestPos), 0);
    result.set(this.buffer.subarray(0, oldestPos), firstChunkLen);

    return result;
  }

  clear(): void {
    this.writePos = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  get maxSize(): number {
    return this.capacity;
  }
}
