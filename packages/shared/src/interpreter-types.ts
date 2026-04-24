// Context Management
export interface CreateContextOptions {
  /**
   * Programming language for the context
   * @default 'python'
   */
  language?: 'python' | 'javascript' | 'typescript';

  /**
   * Working directory for the context
   * @default '/workspace'
   */
  cwd?: string;

  /**
   * Environment variables for the context.
   * Undefined values are skipped (treated as "not configured").
   */
  envVars?: Record<string, string | undefined>;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;
}

export interface CodeContext {
  /**
   * Unique identifier for the context
   */
  readonly id: string;

  /**
   * Programming language of the context
   */
  readonly language: string;

  /**
   * Current working directory
   */
  readonly cwd: string;

  /**
   * When the context was created
   */
  readonly createdAt: Date;

  /**
   * When the context was last used
   */
  readonly lastUsed: Date;
}

// Execution Options
export interface RunCodeOptions {
  /**
   * Context to run the code in. If not provided, uses default context for the language
   */
  context?: CodeContext;

  /**
   * Language to use if context is not provided
   * @default 'python'
   */
  language?: 'python' | 'javascript' | 'typescript';

  /**
   * Environment variables for this execution.
   * Undefined values are skipped (treated as "not configured").
   */
  envVars?: Record<string, string | undefined>;

  /**
   * Execution timeout in milliseconds
   * @default 60000
   */
  timeout?: number;

  /**
   * AbortSignal for cancelling execution
   */
  signal?: AbortSignal;

  /**
   * Callback for stdout output
   */
  onStdout?: (output: OutputMessage) => void | Promise<void>;

  /**
   * Callback for stderr output
   */
  onStderr?: (output: OutputMessage) => void | Promise<void>;

  /**
   * Callback for execution results (charts, tables, etc)
   */
  onResult?: (result: Result) => void | Promise<void>;

  /**
   * Callback for execution errors
   */
  onError?: (error: ExecutionError) => void | Promise<void>;
}

// Output Messages
export interface OutputMessage {
  /**
   * The output text
   */
  text: string;

  /**
   * Timestamp of the output
   */
  timestamp: number;
}

// Execution Results
export interface Result {
  /**
   * Plain text representation
   */
  text?: string;

  /**
   * HTML representation (tables, formatted output)
   */
  html?: string;

  /**
   * PNG image data (base64 encoded)
   */
  png?: string;

  /**
   * JPEG image data (base64 encoded)
   */
  jpeg?: string;

  /**
   * SVG image data
   */
  svg?: string;

  /**
   * LaTeX representation
   */
  latex?: string;

  /**
   * Markdown representation
   */
  markdown?: string;

  /**
   * JavaScript code to execute
   */
  javascript?: string;

  /**
   * JSON data
   */
  json?: any;

  /**
   * Chart data if the result is a visualization
   */
  chart?: ChartData;

  /**
   * Raw data object
   */
  data?: any;

  /**
   * Available output formats
   */
  formats(): string[];
}

// Chart Data
export interface ChartData {
  /**
   * Type of chart
   */
  type:
    | 'line'
    | 'bar'
    | 'scatter'
    | 'pie'
    | 'histogram'
    | 'heatmap'
    | 'unknown';

  /**
   * Chart title
   */
  title?: string;

  /**
   * Chart data (format depends on library)
   */
  data: any;

  /**
   * Chart layout/configuration
   */
  layout?: any;

  /**
   * Additional configuration
   */
  config?: any;

  /**
   * Library that generated the chart
   */
  library?: 'matplotlib' | 'plotly' | 'altair' | 'seaborn' | 'unknown';

  /**
   * Base64 encoded image if available
   */
  image?: string;
}

// Execution Error
export interface ExecutionError {
  /**
   * Error name/type (e.g., 'NameError', 'SyntaxError')
   */
  name: string;

  /**
   * Error message
   */
  message: string;

  /**
   * Stack trace
   */
  traceback: string[];

  /**
   * Line number where error occurred
   */
  lineNumber?: number;
}

// Serializable execution result
export interface ExecutionResult {
  code: string;
  logs: {
    stdout: string[];
    stderr: string[];
  };
  error?: ExecutionError;
  executionCount?: number;
  results: Array<{
    text?: string;
    html?: string;
    png?: string;
    jpeg?: string;
    svg?: string;
    latex?: string;
    markdown?: string;
    javascript?: string;
    json?: any;
    chart?: ChartData;
    data?: any;
  }>;
}

// Execution Result Container
export class Execution {
  /**
   * All results from the execution
   */
  public results: Result[] = [];

  /**
   * Accumulated stdout and stderr
   */
  public logs = {
    stdout: [] as string[],
    stderr: [] as string[]
  };

  /**
   * Execution error if any
   */
  public error?: ExecutionError;

  /**
   * Execution count (for interpreter)
   */
  public executionCount?: number;

  constructor(
    public readonly code: string,
    public readonly context: CodeContext
  ) {}

  /**
   * Convert to a plain object for serialization
   */
  toJSON(): ExecutionResult {
    return {
      code: this.code,
      logs: this.logs,
      error: this.error,
      executionCount: this.executionCount,
      results: this.results.map((result) => ({
        text: result.text,
        html: result.html,
        png: result.png,
        jpeg: result.jpeg,
        svg: result.svg,
        latex: result.latex,
        markdown: result.markdown,
        javascript: result.javascript,
        json: result.json,
        chart: result.chart,
        data: result.data
      }))
    };
  }
}

// Implementation of Result
export class ResultImpl implements Result {
  text?: string;
  html?: string;
  png?: string;
  jpeg?: string;
  svg?: string;
  latex?: string;
  markdown?: string;
  javascript?: string;
  json?: any;
  chart?: ChartData;
  data?: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SSE data has dynamic shape
  constructor(raw: any) {
    this.text = raw.text || raw.data?.['text/plain'];
    this.html = raw.html || raw.data?.['text/html'];
    this.png = raw.png || raw.data?.['image/png'];
    this.jpeg = raw.jpeg || raw.data?.['image/jpeg'];
    this.svg = raw.svg || raw.data?.['image/svg+xml'];
    this.latex = raw.latex || raw.data?.['text/latex'];
    this.markdown = raw.markdown || raw.data?.['text/markdown'];
    this.javascript = raw.javascript || raw.data?.['application/javascript'];
    this.json = raw.json || raw.data?.['application/json'];
    this.chart = raw.chart;
    this.data = raw.data;
  }

  formats(): string[] {
    const fmts: string[] = [];
    if (this.text) fmts.push('text');
    if (this.html) fmts.push('html');
    if (this.png) fmts.push('png');
    if (this.jpeg) fmts.push('jpeg');
    if (this.svg) fmts.push('svg');
    if (this.latex) fmts.push('latex');
    if (this.markdown) fmts.push('markdown');
    if (this.javascript) fmts.push('javascript');
    if (this.json) fmts.push('json');
    if (this.chart) fmts.push('chart');
    return fmts;
  }
}
