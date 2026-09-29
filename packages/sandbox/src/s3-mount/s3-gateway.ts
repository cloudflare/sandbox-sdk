import { WorkerEntrypoint } from "cloudflare:workers";

import { type S3GatewayProps } from "./contracts.js";
import { handleS3GatewayRequest } from "./gateway.js";

export class S3Gateway extends WorkerEntrypoint<object, S3GatewayProps> {
  override fetch(request: Request): Promise<Response> {
    return handleS3GatewayRequest(request, this.ctx.props);
  }
}
