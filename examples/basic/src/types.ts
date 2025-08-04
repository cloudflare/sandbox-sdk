// API Response Types

export interface CreateSessionResponse {
  sessionId: string;
  language: string;
}

export interface ExecuteCellResponse {
  stdout: string;
  stderr: string;
  results: Array<{
    type: string;
    data?: any;
    text?: string;
    html?: string;
    png?: string;
    jpeg?: string;
    svg?: string;
  }>;
  error?: {
    name: string;
    value: string;
    traceback: string[];
  };
}

export interface ExampleResponse {
  output?: string;
  error?: any;
  errors?: any;
  result?: any;
  chart?: string | null;
  formats?: string[];
}