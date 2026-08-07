class Entrypoint<Env = unknown> {
  ctx: any;
  env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> extends Entrypoint<Env> {}
export class WorkerEntrypoint<Env = unknown> extends Entrypoint<Env> {}

class Span {
  attributes = new Map<string, unknown>();
  setAttribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
  }
}

export const tracing = {
  enterSpan<T>(_name: string, callback: (span: Span) => T): T {
    return callback(new Span());
  }
};
