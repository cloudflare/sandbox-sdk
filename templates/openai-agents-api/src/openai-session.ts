import { z } from 'zod';

const environmentTypeSchema = z.enum(['none', 'self_hosted', 'openai_hosted']);
const sessionStatusSchema = z.enum([
  'in_progress',
  'idle',
  'requires_action',
  'failed'
]);

const openAISessionSchema = z.object({
  status: sessionStatusSchema,
  agent: z.object({ id: z.string().min(1) }),
  environment: z.object({
    type: z.string().min(1),
    id: z.string().min(1).optional(),
    remote_url: z.string().url().optional()
  }),
  required_actions: z
    .array(
      z.object({
        type: z.string().min(1),
        environment_id: z.string().min(1).optional()
      })
    )
    .default([])
});

export interface OpenAISession {
  status: z.infer<typeof sessionStatusSchema>;
  agentID: string;
  environmentType: string;
  environmentID?: string;
  remoteURL?: string;
  requiredActions: Array<{
    type: string;
    environmentID?: string;
  }>;
}

const eventEnvelope = {
  id: z.string().min(1),
  object: z.literal('event'),
  created_at: z.number().int()
};

const createdEventSchema = z.object({
  ...eventEnvelope,
  type: z.literal('agent.session.created'),
  data: z.discriminatedUnion('environment_type', [
    z.object({
      id: z.string().min(1),
      environment_type: z.literal('self_hosted'),
      environment_id: z.string().min(1),
      connect: z.object({ remote_url: z.string().url() })
    }),
    z.object({
      id: z.string().min(1),
      environment_type: z.literal('openai_hosted'),
      environment_id: z.string().min(1),
      connect: z.never().optional()
    }),
    z.object({
      id: z.string().min(1),
      environment_type: z.literal('none'),
      environment_id: z.never().optional(),
      connect: z.never().optional()
    })
  ])
});

const actionRequiredEventSchema = z.object({
  ...eventEnvelope,
  type: z.literal('agent.session.action_required'),
  data: z.object({
    id: z.string().min(1),
    required_action: z.object({
      type: z.enum(['function_call', 'environment_connection'])
    })
  })
});

function sessionStateEventSchema<
  Type extends
    | 'agent.session.in_progress'
    | 'agent.session.idle'
    | 'agent.session.failed'
>(type: Type) {
  return z.object({
    ...eventEnvelope,
    type: z.literal(type),
    data: z.object({
      id: z.string().min(1),
      environment_type: environmentTypeSchema,
      environment_id: z.string().min(1).optional()
    })
  });
}

const inProgressEventSchema = sessionStateEventSchema(
  'agent.session.in_progress'
);
const idleEventSchema = sessionStateEventSchema('agent.session.idle');
const failedEventSchema = sessionStateEventSchema('agent.session.failed');

export const webhookEventSchema = z.discriminatedUnion('type', [
  createdEventSchema,
  actionRequiredEventSchema,
  inProgressEventSchema,
  idleEventSchema,
  failedEventSchema
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

const supportedEventTypes = new Set<WebhookEvent['type']>([
  'agent.session.created',
  'agent.session.action_required',
  'agent.session.in_progress',
  'agent.session.idle',
  'agent.session.failed'
]);

export function parseOpenAISession(value: unknown): OpenAISession {
  const session = openAISessionSchema.parse(value);
  return {
    status: session.status,
    agentID: session.agent.id,
    environmentType: session.environment.type,
    ...(session.environment.id
      ? { environmentID: session.environment.id }
      : {}),
    ...(session.environment.remote_url
      ? { remoteURL: session.environment.remote_url }
      : {}),
    requiredActions: session.required_actions.map((action) => ({
      type: action.type,
      ...(action.environment_id === undefined
        ? {}
        : { environmentID: action.environment_id })
    }))
  };
}

export function parseWebhookEvent(value: unknown): WebhookEvent | undefined {
  const typeResult = z.object({ type: z.string() }).safeParse(value);
  if (!typeResult.success) return undefined;
  if (!supportedEventTypes.has(typeResult.data.type as WebhookEvent['type'])) {
    return undefined;
  }
  return webhookEventSchema.parse(value);
}
