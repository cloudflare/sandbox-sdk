import { tracing } from 'cloudflare:workers';
import OpenAI from 'openai';
import { ExecutorEnvironment } from './executor-environment';
import { parseWebhookEvent, type WebhookEvent } from './openai-session';

export { ExecutorEnvironment };

const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
const PENDING_WEBHOOK_SECRET = 'pending-webhook-registration';

const HEALTH_ROUTE = new URLPattern({ pathname: '/health' });
const WEBHOOK_ROUTE = new URLPattern({ pathname: '/webhook' });
const EXECUTOR_ROUTE = new URLPattern({ pathname: '/executors/:sessionID' });

class RequestBodyTooLargeError extends Error {}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return tracing.enterSpan('agents-api.request', async (span) => {
      const requestURL = new URL(request.url);
      span.setAttribute('http.request.method', request.method);
      span.setAttribute('url.path', requestURL.pathname);

      if (request.method === 'GET' && HEALTH_ROUTE.test(requestURL)) {
        return Response.json({
          service: 'openai-agents-api-executor',
          configured: isExecutorConfigured(env),
          webhook_configured: isWebhookConfigured(env)
        });
      }

      const executorMatch = EXECUTOR_ROUTE.exec(requestURL);
      const sessionID = executorMatch?.pathname.groups.sessionID;
      if (request.method === 'DELETE' && sessionID) {
        return handleDestroy(request, env, sessionID);
      }

      if (!WEBHOOK_ROUTE.test(requestURL)) {
        return errorResponse(404, 'Not found');
      }
      if (!isWebhookConfigured(env)) {
        return errorResponse(503, 'Webhook is not configured');
      }
      if (request.method !== 'POST') {
        return errorResponse(405, 'Method not allowed');
      }

      return handleWebhook(request, env);
    });
  }
} satisfies ExportedHandler<Env>;

function handleDestroy(
  request: Request,
  env: Env,
  sessionID: string
): Promise<Response> {
  return tracing.enterSpan('agents-api.executor.destroy', async (span) => {
    span.setAttribute('openai.session_id', sessionID);
    if (!(await isAuthorized(request, env.EXECUTOR_CLIENT_SECRET))) {
      return errorResponse(401, 'Unauthorized');
    }

    try {
      await env.EXECUTORS.getByName(sessionID).destroy();
      return new Response(null, { status: 204 });
    } catch (error) {
      const message = errorMessage(error);
      span.setAttribute('error', true);
      span.setAttribute('error.message', message);
      console.error({
        message: 'Could not destroy executor',
        sessionID,
        error: message
      });
      return errorResponse(500, 'Could not destroy executor');
    }
  });
}

function handleWebhook(request: Request, env: Env): Promise<Response> {
  return tracing.enterSpan('agents-api.webhook', async (span) => {
    let payload: string;
    try {
      payload = await readBoundedBody(request, MAX_WEBHOOK_BODY_BYTES);
    } catch (error) {
      span.setAttribute('error', true);
      span.setAttribute('error.message', errorMessage(error));
      return error instanceof RequestBodyTooLargeError
        ? errorResponse(413, 'Webhook payload too large')
        : errorResponse(400, 'Could not read webhook payload');
    }

    const openAI = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      webhookSecret: env.OPENAI_WEBHOOK_SECRET
    });

    let value: unknown;
    try {
      value = await openAI.webhooks.unwrap(payload, request.headers);
    } catch (error) {
      span.setAttribute('error', true);
      span.setAttribute('error.message', errorMessage(error));
      return errorResponse(400, 'Invalid webhook');
    }

    let event: WebhookEvent | undefined;
    try {
      event = parseWebhookEvent(value);
    } catch (error) {
      const message = errorMessage(error);
      span.setAttribute('error', true);
      span.setAttribute('error.message', message);
      return errorResponse(400, 'Invalid webhook event');
    }
    if (!event) return Response.json({ ok: true });

    span.setAttribute('openai.webhook.type', event.type);
    span.setAttribute('openai.webhook.data.id', event.data.id);
    span.setAttribute('openai.session_id', event.data.id);

    try {
      switch (event.type) {
        case 'agent.session.created':
          span.setAttribute(
            'openai.webhook.data.environment_type',
            event.data.environment_type
          );
          if (event.data.environment_id !== undefined) {
            span.setAttribute(
              'openai.webhook.data.environment_id',
              event.data.environment_id
            );
          }
          if (event.data.environment_type === 'self_hosted') {
            span.setAttribute(
              'openai.webhook.data.connect.remote_url',
              event.data.connect.remote_url
            );
          }
          await env.EXECUTORS.getByName(event.data.id).prewarm(event.data.id);
          break;
        case 'agent.session.action_required':
          span.setAttribute(
            'openai.webhook.data.required_action.type',
            event.data.required_action.type
          );
          if (event.data.required_action.type === 'environment_connection') {
            await env.EXECUTORS.getByName(event.data.id).update(event.data.id);
          }
          break;
        case 'agent.session.in_progress':
          span.setAttribute(
            'openai.webhook.data.environment_type',
            event.data.environment_type
          );
          if (event.data.environment_id !== undefined) {
            span.setAttribute(
              'openai.webhook.data.environment_id',
              event.data.environment_id
            );
          }
          await env.EXECUTORS.getByName(event.data.id).update(event.data.id);
          break;
        case 'agent.session.idle':
          span.setAttribute(
            'openai.webhook.data.environment_type',
            event.data.environment_type
          );
          if (event.data.environment_id !== undefined) {
            span.setAttribute(
              'openai.webhook.data.environment_id',
              event.data.environment_id
            );
          }
          await env.EXECUTORS.getByName(event.data.id).update(event.data.id);
          break;
        case 'agent.session.failed':
          span.setAttribute(
            'openai.webhook.data.environment_type',
            event.data.environment_type
          );
          if (event.data.environment_id !== undefined) {
            span.setAttribute(
              'openai.webhook.data.environment_id',
              event.data.environment_id
            );
          }
          await env.EXECUTORS.getByName(event.data.id).update(event.data.id);
          break;
      }
      return Response.json({ ok: true });
    } catch (error) {
      const message = errorMessage(error);
      span.setAttribute('error', true);
      span.setAttribute('error.message', message);
      console.error({
        message: 'Could not update executor from webhook',
        sessionID: event.data.id,
        error: message
      });
      return errorResponse(500, 'Could not update executor from webhook');
    }
  });
}

async function isAuthorized(
  request: Request,
  expected: string
): Promise<boolean> {
  if (!expected) return false;
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const provided = authorization.slice('Bearer '.length);
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function isWebhookConfigured(env: Env): boolean {
  return Boolean(
    env.OPENAI_API_KEY &&
    env.OPENAI_AGENT_ID &&
    env.OPENAI_WEBHOOK_SECRET &&
    env.OPENAI_WEBHOOK_SECRET !== PENDING_WEBHOOK_SECRET
  );
}

function isExecutorConfigured(env: Env): boolean {
  const seconds = Number(env.EXECUTOR_KEEP_ALIVE_SECONDS);
  return Boolean(
    env.OPENAI_EXECUTOR_API_KEY &&
    env.EXECUTOR_CLIENT_SECRET &&
    Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds <= 604_800
  );
}

async function readBoundedBody(
  request: Request,
  limit: number
): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RequestBodyTooLargeError(
        `Request body exceeds ${limit} bytes.`
      );
    }
    text += decoder.decode(value, { stream: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
