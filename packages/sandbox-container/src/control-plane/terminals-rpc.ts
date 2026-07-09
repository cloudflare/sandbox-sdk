import type { SandboxTerminalsAPI, TerminalOutputEvent } from '@repo/shared';
import { RpcTarget } from 'capnweb';
import type { TerminalManager } from '../services/terminal-manager';
import { StreamSubscriptionRPC } from './subscription-rpc';

export class TerminalsRPCAPI extends RpcTarget implements SandboxTerminalsAPI {
  #terminalManager: TerminalManager;

  constructor(terminalManager: TerminalManager) {
    super();
    this.#terminalManager = terminalManager;
  }

  create(options: Parameters<SandboxTerminalsAPI['create']>[0]) {
    return this.#terminalManager.create(options);
  }

  get(id: string) {
    return this.#terminalManager.get(id);
  }

  list() {
    return this.#terminalManager.list();
  }

  async output(
    id: string,
    options?: Parameters<SandboxTerminalsAPI['output']>[1]
  ) {
    return new StreamSubscriptionRPC<TerminalOutputEvent>(
      await this.#terminalManager.output(id, options)
    );
  }

  write(id: string, data: Uint8Array) {
    return this.#terminalManager.write(id, data);
  }

  resize(id: string, cols: number, rows: number) {
    return this.#terminalManager.resize(id, cols, rows);
  }

  interrupt(id: string) {
    return this.#terminalManager.interrupt(id);
  }

  terminate(id: string) {
    return this.#terminalManager.terminate(id);
  }

  hasActive() {
    return this.#terminalManager.hasActive();
  }
}
