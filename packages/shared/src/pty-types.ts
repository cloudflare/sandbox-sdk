export interface PtyOptions {
  cols?: number;
  rows?: number;
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
