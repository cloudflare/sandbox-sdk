import { StatelessProcessRunner } from './stateless-process-runner';

export type StatelessCommandExecOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

export type StatelessCommandExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export class StatelessCommandRunner {
  private readonly processes = new StatelessProcessRunner();

  async exec(
    command: string,
    options: StatelessCommandExecOptions = {}
  ): Promise<StatelessCommandExecResult> {
    const result = await this.processes.start(command, options).wait();

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    };
  }
}
