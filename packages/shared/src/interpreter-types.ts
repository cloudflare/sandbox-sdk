// Context Management
export interface CreateContextOptions {
  /**
   * Programming language for the context
   * @default 'python'
   */
  language?: "python" | "javascript" | "typescript";

  /**
   * Working directory for the context
   * @default '/workspace'
   */
  cwd?: string;

  /**
   * Environment variables for the context
   */
  envVars?: Record<string, string>;

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
  language?: "python" | "javascript" | "typescript";

  /**
   * Environment variables for this execution
   */
  envVars?: Record<string, string>;

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
    | "line"
    | "bar"
    | "scatter"
    | "pie"
    | "histogram"
    | "heatmap"
    | "unknown";

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
  library?: "matplotlib" | "plotly" | "altair" | "seaborn" | "unknown";

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
    stderr: [] as string[],
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
        data: result.data,
      })),
    };
  }
}

// Implementation of Result
export class ResultImpl implements Result {
  constructor(private raw: any) {}

  get text(): string | undefined {
    return this.raw.text || this.raw.data?.["text/plain"];
  }

  get html(): string | undefined {
    return this.raw.html || this.raw.data?.["text/html"];
  }

  get png(): string | undefined {
    return this.raw.png || this.raw.data?.["image/png"];
  }

  get jpeg(): string | undefined {
    return this.raw.jpeg || this.raw.data?.["image/jpeg"];
  }

  get svg(): string | undefined {
    return this.raw.svg || this.raw.data?.["image/svg+xml"];
  }

  get latex(): string | undefined {
    return this.raw.latex || this.raw.data?.["text/latex"];
  }

  get markdown(): string | undefined {
    return this.raw.markdown || this.raw.data?.["text/markdown"];
  }

  get javascript(): string | undefined {
    return this.raw.javascript || this.raw.data?.["application/javascript"];
  }

  get json(): any {
    return this.raw.json || this.raw.data?.["application/json"];
  }

  get chart(): ChartData | undefined {
    return this.raw.chart;
  }

  get data(): any {
    return this.raw.data;
  }

  formats(): string[] {
    const formats: string[] = [];
    if (this.text) formats.push("text");
    if (this.html) formats.push("html");
    if (this.png) formats.push("png");
    if (this.jpeg) formats.push("jpeg");
    if (this.svg) formats.push("svg");
    if (this.latex) formats.push("latex");
    if (this.markdown) formats.push("markdown");
    if (this.javascript) formats.push("javascript");
    if (this.json) formats.push("json");
    if (this.chart) formats.push("chart");
    return formats;
  }
}
