export class DurableObject<Environment> {
  protected ctx: DurableObjectState;
  protected env: Environment;

  constructor(ctx: DurableObjectState, env: Environment) {
    this.ctx = ctx;
    this.env = env;
  }
}

export const spanAttributes: Array<[string, unknown]> = [];

export function resetSpanAttributes(): void {
  spanAttributes.length = 0;
}

export const tracing = {
  enterSpan<T>(
    _name: string,
    callback: (span: { setAttribute(name: string, value: unknown): void }) => T
  ): T {
    return callback({
      setAttribute(name, value) {
        spanAttributes.push([name, value]);
      }
    });
  }
};
