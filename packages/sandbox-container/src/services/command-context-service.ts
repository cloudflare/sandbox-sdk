import type { InternalCommandResult } from './internal-command-result';
import type {
  InternalCommandOptions,
  InternalCommandRunner
} from './internal-command-runner';

export type ContextExec = (
  command: string,
  options?: InternalCommandOptions
) => Promise<InternalCommandResult>;

export class CommandContextService {
  constructor(private readonly runner: InternalCommandRunner) {}

  run(
    command: string,
    options?: InternalCommandOptions
  ): Promise<InternalCommandResult> {
    return this.runner.run(command, options);
  }

  async withExecution<T>(
    options: InternalCommandOptions,
    fn: (exec: ContextExec) => Promise<T>
  ): Promise<T> {
    const exec: ContextExec = (command, overrides = {}) =>
      this.run(command, {
        ...options,
        ...overrides,
        env:
          options.env || overrides.env
            ? { ...options.env, ...overrides.env }
            : undefined
      });

    return fn(exec);
  }
}
