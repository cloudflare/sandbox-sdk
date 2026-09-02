import { DurableObject } from "cloudflare:workers";

import { ContainerFiles } from "./container-files.js";

export abstract class Sandbox<Env, Props = {}> extends DurableObject<Env, Props> {
  readonly files: ContainerFiles;

  constructor(ctx: DurableObjectState<Props>, env: Env) {
    super(ctx, env);

    if (ctx.container === undefined) {
      throw new Error("Sandbox requires a container-enabled Durable Object");
    }

    this.files = new ContainerFiles(ctx.container);
  }
}
