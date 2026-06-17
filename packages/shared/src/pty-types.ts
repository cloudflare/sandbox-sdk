export interface PtyOptions {
  cols?: number;
  rows?: number;
  shell?: string;
}

export interface TerminalOptions {
  id?: string;
  cwd?: string;
  shell?: string;
}

export interface TerminalConnectOptions {
  cols?: number;
  rows?: number;
}

export interface SandboxTerminal {
  readonly id: string;
  connect(
    request: Request,
    options?: TerminalConnectOptions
  ): Promise<Response>;
  destroy(): Promise<void>;
}

export type PtyControlMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type PtyStatusMessage =
  | { type: 'ready' }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string };
