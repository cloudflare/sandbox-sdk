import type {
  TerminalOutputEvent,
  TerminalOutputOptions,
  TerminalSnapshot
} from '@repo/shared';
import type { ProcessPullSubscriptionRPC } from '../processes/rpc-types';

export interface TerminalCapabilityRPC {
  getSnapshot(): Promise<TerminalSnapshot | null>;
  openOutput(
    options?: Omit<TerminalOutputOptions, 'signal'>
  ): Promise<ProcessPullSubscriptionRPC<TerminalOutputEvent>>;
  write(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
  authorizeConnection(): Promise<string>;
}

export interface TerminalRPCDescriptor {
  snapshot: TerminalSnapshot;
  runtimeIncarnationID: string;
  capability: TerminalCapabilityRPC;
}
