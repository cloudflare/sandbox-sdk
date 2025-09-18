import type { InterpreterClient } from "./interpreter-client.js";
import {
  type CodeContext,
  type CreateContextOptions,
  Execution,
  ResultImpl,
  type RunCodeOptions,
} from "./interpreter-types.js";
import type { Sandbox } from "./sandbox.js";

export class CodeInterpreter {
  private interpreterClient: InterpreterClient;
  private contexts = new Map<string, CodeContext>();

  constructor(sandbox: Sandbox) {
    this.interpreterClient = sandbox.client as InterpreterClient;
  }

  /**
   * Create a new code execution context
   */
  async createCodeContext(
    options: CreateContextOptions = {}
  ): Promise<CodeContext> {
    const context = await this.interpreterClient.createCodeContext(options);
    this.contexts.set(context.id, context);
    return context;
  }

  /**
   * Run code with optional context
   */
  async runCode(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<Execution> {
    // Get or create context
    let context = options.context;
    if (!context) {
      // Try to find or create a default context for the language
      const language = options.language || "python";
      context = await this.getOrCreateDefaultContext(language);
    }

    // Create execution object to collect results
    const execution = new Execution(code, context);

    // Stream execution
    await this.interpreterClient.runCodeStream(context.id, code, options.language, {
      onStdout: (output) => {
        execution.logs.stdout.push(output.text);
        if (options.onStdout) return options.onStdout(output);
      },
      onStderr: (output) => {
        execution.logs.stderr.push(output.text);
        if (options.onStderr) return options.onStderr(output);
      },
      onResult: async (result) => {
        execution.results.push(new ResultImpl(result) as any);
        if (options.onResult) return options.onResult(result);
      },
      onError: (error) => {
        execution.error = error;
        if (options.onError) return options.onError(error);
      },
    });

    return execution;
  }

  /**
   * Run code and return a streaming response
   */
  async runCodeStream(
    code: string,
    options: RunCodeOptions = {}
  ): Promise<ReadableStream> {
    // Get or create context
    let context = options.context;
    if (!context) {
      const language = options.language || "python";
      context = await this.getOrCreateDefaultContext(language);
    }

    // Create streaming response
    const response = await this.interpreterClient.doFetch("/api/execute/code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        context_id: context.id,
        code,
        language: options.language,
      }),
    });

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({ error: "Unknown error" }))) as { error?: string };
      throw new Error(
        errorData.error || `Failed to execute code: ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error("No response body for streaming execution");
    }

    return response.body;
  }

  /**
   * List all code contexts
   */
  async listCodeContexts(): Promise<CodeContext[]> {
    const contexts = await this.interpreterClient.listCodeContexts();

    // Update local cache
    for (const context of contexts) {
      this.contexts.set(context.id, context);
    }

    return contexts;
  }

  /**
   * Delete a code context
   */
  async deleteCodeContext(contextId: string): Promise<void> {
    await this.interpreterClient.deleteCodeContext(contextId);
    this.contexts.delete(contextId);
  }

  private async getOrCreateDefaultContext(
    language: "python" | "javascript" | "typescript"
  ): Promise<CodeContext> {
    // Check if we have a cached context for this language
    for (const context of this.contexts.values()) {
      if (context.language === language) {
        return context;
      }
    }

    // Create new default context
    return this.createCodeContext({ language });
  }
}
