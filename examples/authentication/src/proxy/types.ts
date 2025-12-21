export interface ProxyTokenPayload {
  sandboxId: string;
  sessionId?: string;
  exp: number;
  iat: number;
}

export interface CreateProxyTokenOptions {
  secret: string;
  sandboxId: string;
  sessionId?: string;
  /** '15m', '1h', '8h', or seconds. Default: '15m' */
  expiresIn?: string;
}

export interface VerifyProxyTokenOptions {
  secret: string;
  token: string;
}

export interface ProxyContext<Env = unknown> {
  jwt: ProxyTokenPayload;
  env: Env;
  service: string;
  request: Request;
}

export interface ServiceConfig<Env = unknown> {
  target: string;
  /** Extract the proxy token from the incoming request */
  validate: (request: Request) => string | null | Promise<string | null>;
  /** Inject real credentials. Return Response to short-circuit with an error. */
  transform: (
    request: Request,
    ctx: ProxyContext<Env>
  ) => Promise<Request | Response>;
}

export interface ProxyHandlerConfig<Env = unknown> {
  mountPath: string;
  jwtSecret: (env: Env) => string;
  services: Record<string, ServiceConfig<Env>>;
}

export type ProxyHandler<Env = unknown> = (
  request: Request,
  env: Env
) => Promise<Response>;
