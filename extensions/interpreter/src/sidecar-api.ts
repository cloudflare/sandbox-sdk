export interface InterpreterContextWire {
  id: string;
  language: string;
  cwd: string;
  createdAt: string;
  lastUsed: string;
}

export type InterpreterSidecarEvent =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'result';
      metadata: Record<string, unknown>;
      [key: string]: unknown;
    }
  | { type: 'execution_complete'; execution_count: number }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] };

export interface InterpreterSidecarAPI {
  createContext(options: {
    language?: string;
    cwd?: string;
  }): Promise<InterpreterContextWire>;
  listContexts(): Promise<InterpreterContextWire[]>;
  deleteContext(contextId: string): Promise<void>;
  interruptContext(contextId: string): Promise<void>;
  runCode(
    contextId: string,
    code: string,
    language: string | undefined,
    onEvent: (event: InterpreterSidecarEvent) => void | Promise<void>
  ): Promise<void>;
}
