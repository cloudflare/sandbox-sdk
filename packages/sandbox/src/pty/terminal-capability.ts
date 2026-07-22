import { RpcTarget } from 'cloudflare:workers';
import type {
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalSnapshot
} from '@repo/shared';
import type { ProcessPullSubscriptionRPC } from '../processes/rpc-types';
import type { TerminalCapabilityRPC } from './rpc-types';

export interface TerminalCapabilityControl {
  get(id: string): Promise<TerminalSnapshot | null>;
  openOutput(
    id: string,
    options?: Omit<TerminalOutputOptions, 'signal'>
  ): Promise<ProcessPullSubscriptionRPC<TerminalOutputEvent>>;
  write(id: string, data: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  interrupt(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  authorizeConnection(): Promise<string>;
}

export class TerminalCapabilityTarget
  extends RpcTarget
  implements TerminalCapabilityRPC
{
  readonly #id: string;
  readonly #control: TerminalCapabilityControl;

  constructor(id: string, control: TerminalCapabilityControl) {
    super();
    this.#id = id;
    this.#control = control;
  }

  getSnapshot(): Promise<TerminalSnapshot | null> {
    return this.#control.get(this.#id);
  }

  openOutput(
    options?: Omit<TerminalOutputOptions, 'signal'>
  ): Promise<ProcessPullSubscriptionRPC<TerminalOutputEvent>> {
    return this.#control.openOutput(this.#id, options);
  }

  write(data: Uint8Array): Promise<void> {
    return this.#control.write(this.#id, data);
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.#control.resize(this.#id, cols, rows);
  }

  interrupt(): Promise<void> {
    return this.#control.interrupt(this.#id);
  }

  terminate(): Promise<void> {
    return this.#control.terminate(this.#id);
  }

  authorizeConnection(): Promise<string> {
    return this.#control.authorizeConnection();
  }
}
