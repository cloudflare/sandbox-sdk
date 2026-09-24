import { describe, expect, it } from 'vitest';
import { parseOpenAISession, parseWebhookEvent } from '../src/openai-session';

const envelope = {
  id: 'evt_123',
  object: 'event',
  created_at: 1_750_287_018
} as const;

function createdEvent(overrides: Record<string, unknown> = {}) {
  return {
    ...envelope,
    type: 'agent.session.created',
    data: {
      id: 'sess_abc123',
      environment_id: 'ccarenv_abc123',
      environment_type: 'self_hosted',
      connect: {
        remote_url: 'https://api.openai.com/v1/agents/api'
      },
      ...overrides
    }
  };
}

describe('parseOpenAISession', () => {
  it('maps current executor connection state', () => {
    expect(
      parseOpenAISession({
        status: 'requires_action',
        agent: { id: 'agent_1' },
        environment: {
          type: 'self_hosted',
          id: 'env_1',
          remote_url: 'https://api.openai.com/v1/agents/api'
        },
        required_actions: [
          { type: 'environment_connection', environment_id: 'env_1' }
        ]
      })
    ).toEqual({
      status: 'requires_action',
      agentID: 'agent_1',
      environmentType: 'self_hosted',
      environmentID: 'env_1',
      remoteURL: 'https://api.openai.com/v1/agents/api',
      requiredActions: [
        { type: 'environment_connection', environmentID: 'env_1' }
      ]
    });
  });

  it('defaults omitted required actions to an empty list', () => {
    expect(
      parseOpenAISession({
        status: 'idle',
        agent: { id: 'agent_1' },
        environment: { type: 'self_hosted' }
      }).requiredActions
    ).toEqual([]);
  });

  it('rejects malformed session payloads', () => {
    expect(() =>
      parseOpenAISession({
        status: 'in_progress',
        agent: {},
        environment: { type: 'self_hosted' }
      })
    ).toThrow();
  });

  it('rejects an unknown session status', () => {
    expect(() =>
      parseOpenAISession({
        status: 'future_status',
        agent: { id: 'agent_1' },
        environment: { type: 'self_hosted' }
      })
    ).toThrow();
  });
});

describe('parseWebhookEvent', () => {
  it('parses the self-hosted created example', () => {
    const event = createdEvent();
    expect(parseWebhookEvent(event)).toEqual(event);
  });

  it.each(['function_call', 'environment_connection'] as const)(
    'parses the %s action-required example',
    (type) => {
      const event = {
        ...envelope,
        type: 'agent.session.action_required',
        data: {
          id: 'sess_abc123',
          required_action: { type }
        }
      };
      expect(parseWebhookEvent(event)).toEqual(event);
    }
  );

  it.each([
    'agent.session.in_progress',
    'agent.session.idle',
    'agent.session.failed'
  ] as const)('parses the %s example', (type) => {
    const event = {
      ...envelope,
      type,
      data: {
        id: 'sess_abc123',
        environment_id: 'ccarenv_abc123',
        environment_type: 'self_hosted'
      }
    };
    expect(parseWebhookEvent(event)).toEqual(event);
  });

  it.each([
    ['environment_id', createdEvent({ environment_id: undefined })],
    ['connect', createdEvent({ connect: undefined })],
    ['remote_url', createdEvent({ connect: {} })],
    ['null environment_id', createdEvent({ environment_id: null })]
  ])(
    'rejects a malformed supported created event without %s',
    (_name, event) => {
      expect(() => parseWebhookEvent(event)).toThrow();
    }
  );

  it('rejects a supported event with missing envelope fields', () => {
    expect(() =>
      parseWebhookEvent({
        type: 'agent.session.idle',
        data: {
          id: 'sess_abc123',
          environment_type: 'self_hosted'
        }
      })
    ).toThrow();
  });

  it('rejects null instead of an omitted optional environment ID', () => {
    expect(() =>
      parseWebhookEvent({
        ...envelope,
        type: 'agent.session.idle',
        data: {
          id: 'sess_abc123',
          environment_id: null,
          environment_type: 'self_hosted'
        }
      })
    ).toThrow();
  });

  it('ignores an unknown future event type', () => {
    expect(
      parseWebhookEvent({
        ...envelope,
        type: 'agent.session.future_state',
        data: { id: 'sess_abc123' }
      })
    ).toBeUndefined();
  });
});
