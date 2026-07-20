import {
  ErrorCode,
  type RuntimeMetadata,
  type SandboxControlCallback
} from '@repo/shared';

export const CONTROL_PROTOCOL_VERSION = 1;

export interface ControlSessionOptions {
  metadata: RuntimeMetadata;
  connectionID: string;
  peerCallback: SandboxControlCallback | undefined;
  registerControlCallback: (
    connectionID: string,
    callback: SandboxControlCallback
  ) => void;
  clearControlCallback: (connectionID: string) => void;
}

export function controlProtocolIncompatible(message: string): Error {
  return Object.assign(new Error(message), {
    code: ErrorCode.CONTROL_PROTOCOL_INCOMPATIBLE
  });
}

export class ControlSession {
  #metadata: RuntimeMetadata;
  #connectionID: string;
  #peerCallback: SandboxControlCallback | undefined;
  #registerControlCallback: (
    connectionID: string,
    callback: SandboxControlCallback
  ) => void;
  #clearControlCallback: (connectionID: string) => void;
  #active = false;
  #registered = false;
  #closed = false;

  constructor(options: ControlSessionOptions) {
    this.#metadata = options.metadata;
    this.#connectionID = options.connectionID;
    this.#peerCallback = options.peerCallback;
    this.#registerControlCallback = options.registerControlCallback;
    this.#clearControlCallback = options.clearControlCallback;
  }

  get metadata(): RuntimeMetadata {
    return this.#metadata;
  }

  setPeerCallback(callback: SandboxControlCallback): void {
    this.#peerCallback = callback;
  }

  assertActive(): void {
    if (!this.#active) {
      throw controlProtocolIncompatible('Control session is not activated');
    }
  }

  async activate(
    expectedRuntimeIncarnationID: string
  ): Promise<RuntimeMetadata> {
    if (expectedRuntimeIncarnationID !== this.#metadata.runtimeIncarnationID) {
      throw controlProtocolIncompatible('Runtime incarnation does not match');
    }

    if (this.#closed) {
      if (this.#active) return this.#metadata;
      throw controlProtocolIncompatible('Control session is closed');
    }

    if (!this.#active) {
      this.#active = true;
      if (this.#peerCallback) {
        this.#registerControlCallback(this.#connectionID, this.#peerCallback);
        this.#registered = true;
      }
    }

    return this.#metadata;
  }

  close(): void {
    this.#closed = true;
    if (this.#registered) {
      this.#clearControlCallback(this.#connectionID);
    }
  }
}
