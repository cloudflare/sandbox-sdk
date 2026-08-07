import { describe, expect, it } from 'vitest';
import { computeErrorAttributes } from '../src/container-control/tracing';

/**
 * Tests for computeErrorAttributes — the pure error → span-attribute mapping
 * used by the RPC tracing helper.
 *
 * The key behavior under test is cause-chain capture: the base
 * `@cloudflare/containers` class wraps the true failure inside
 * `new Error(NO_CONTAINER_INSTANCE_ERROR, { cause })`, so the real reason
 * (e.g. "the container is not listening", "Network connection lost") is only
 * visible on `.cause`. Without stamping the chain, every capacity/startup
 * failure looks identical in traces.
 */
describe('computeErrorAttributes', () => {
  it('stamps message and stack for a plain Error', () => {
    const err = new Error('boom');
    const attrs = computeErrorAttributes(err);
    expect(attrs.error).toBe('boom');
    expect(typeof attrs['error.stack']).toBe('string');
  });

  it('stamps a string code when present', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'CONTAINER_UNAVAILABLE'
    });
    const attrs = computeErrorAttributes(err);
    expect(attrs['error.code']).toBe('CONTAINER_UNAVAILABLE');
  });

  it('stringifies a non-Error thrown value', () => {
    const attrs = computeErrorAttributes('just a string');
    expect(attrs.error).toBe('just a string');
  });

  it('stamps the immediate cause message', () => {
    const cause = new Error('the container is not listening');
    const err = new Error(
      'there is no container instance that can be provided to this durable object',
      { cause }
    );
    const attrs = computeErrorAttributes(err);
    expect(attrs.error).toBe(
      'there is no container instance that can be provided to this durable object'
    );
    expect(attrs['error.cause']).toBe('the container is not listening');
  });

  it('stamps the cause code when the cause carries one', () => {
    const cause = Object.assign(new Error('not listening'), {
      code: 'NOT_LISTENING'
    });
    const err = new Error('wrapper', { cause });
    const attrs = computeErrorAttributes(err);
    expect(attrs['error.cause.code']).toBe('NOT_LISTENING');
  });

  it('joins a multi-level cause chain into error.cause_chain', () => {
    const root = new Error('Network connection lost');
    const mid = new Error('the container is not listening', { cause: root });
    const top = new Error('there is no container instance', { cause: mid });
    const attrs = computeErrorAttributes(top);
    const chain = attrs['error.cause_chain'];
    expect(typeof chain).toBe('string');
    expect(chain).toContain('the container is not listening');
    expect(chain).toContain('Network connection lost');
  });

  it('handles a non-Error cause value', () => {
    const err = new Error('wrapper', { cause: 'raw string cause' });
    const attrs = computeErrorAttributes(err);
    expect(attrs['error.cause']).toBe('raw string cause');
  });

  it('does not emit cause attributes when there is no cause', () => {
    const attrs = computeErrorAttributes(new Error('lonely'));
    expect(attrs['error.cause']).toBeUndefined();
    expect(attrs['error.cause_chain']).toBeUndefined();
  });

  it('terminates on a cyclic cause chain without hanging', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b; // cycle
    const attrs = computeErrorAttributes(b);
    // Should complete and include what it walked before bailing.
    expect(attrs['error.cause']).toBe('a');
    expect(typeof attrs['error.cause_chain']).toBe('string');
  });
});
