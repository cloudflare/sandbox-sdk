export abstract class WorkerEntrypoint<Environment = Cloudflare.Env, Props = object> {
  protected readonly ctx: ExecutionContext<Props>;
  protected readonly env: Environment;

  constructor(ctx: ExecutionContext<Props>, env: Environment) {
    this.ctx = ctx;
    this.env = env;
  }
}
