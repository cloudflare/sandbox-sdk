import {
  ContainerProxy as BaseContainerProxy,
  type OutboundHandlerContext
} from '@cloudflare/containers';
import type { S3CredentialProxyParams } from '../types';
import { type R2EgressParams, r2EgressHandler } from './r2-egress-handler';
import { s3CredentialProxyHandler } from './s3-credential-proxy-handler';

export const CONTAINER_PROXY_CLASS_NAME = 'ContainerProxy';
export const S3_CREDENTIAL_PROXY_HOST = 's3-credential-proxy.internal';
export const S3_CREDENTIAL_PROXY_DIAGNOSTIC_HOST =
  's3-credential-proxy.sandbox.test';

export type SDKOutboundMethod = keyof typeof SDK_OUTBOUND_HANDLERS;

export type OutboundHandlerRegistry = {
  outboundHandlers?: Record<string, unknown>;
};

export const SDK_OUTBOUND_HANDLERS = {
  r2EgressMount: r2EgressHandler,
  s3CredentialProxyMount: s3CredentialProxyHandler
};

export function installSDKOutboundHandlers(constructorRef: Function): void {
  const registry = constructorRef as unknown as OutboundHandlerRegistry;
  registry.outboundHandlers = {
    ...(registry.outboundHandlers ?? {}),
    ...SDK_OUTBOUND_HANDLERS
  };
}

type ContainerProxyProps = {
  outboundByHostOverrides?: Record<
    string,
    { method: SDKOutboundMethod | string; params?: unknown }
  >;
  containerId?: string;
  className?: string;
};

export class ContainerProxy extends BaseContainerProxy {
  async fetch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    const props = this.ctx.props as ContainerProxyProps;
    const override = props.outboundByHostOverrides?.[hostname];
    if (!override) return super.fetch(request);

    const handlerCtx = {
      containerId: props.containerId ?? '',
      className: props.className ?? '',
      params: override.params
    };

    switch (override.method) {
      case 'r2EgressMount':
        return r2EgressHandler(
          request,
          this.env as Cloudflare.Env,
          handlerCtx as OutboundHandlerContext<R2EgressParams>
        );
      case 's3CredentialProxyMount':
        return s3CredentialProxyHandler(
          request,
          this.env as Cloudflare.Env,
          handlerCtx as OutboundHandlerContext<S3CredentialProxyParams>
        );
      default:
        return super.fetch(request);
    }
  }
}

(ContainerProxy as unknown as OutboundHandlerRegistry).outboundHandlers =
  SDK_OUTBOUND_HANDLERS;
