import { describe, expect, it } from 'vitest';
import {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError,
  matchContainerUnavailable
} from '../src/platform-errors';

describe('platform error classifiers', () => {
  it('detects Durable Object code update reset messages', () => {
    expect(
      isDurableObjectCodeUpdateReset(
        new Error('Durable Object reset because its code was updated.')
      )
    ).toBe(true);
    expect(
      isDurableObjectCodeUpdateReset(
        new Error(
          'This script has been upgraded. Please send a new request to connect to the new version.'
        )
      )
    ).toBe(true);
  });

  it('walks cause chains', () => {
    const cause = new Error(
      'Durable Object reset because its code was updated.'
    );
    const wrapper = new Error('outer wrapper', { cause });

    expect(isDurableObjectCodeUpdateReset(wrapper)).toBe(true);
    expect(isPlatformTransientError(wrapper)).toBe(true);
  });

  it('detects platform retryable and network-lost errors', () => {
    expect(
      isPlatformTransientError(new Error('Network connection lost.'))
    ).toBe(true);
    expect(isPlatformTransientError({ retryable: true })).toBe(true);
  });

  it('detects Durable Object storage startup resets as transient platform errors', () => {
    expect(
      isPlatformTransientError(
        new Error(
          'Internal error while starting up Durable Object storage caused object to be reset; reference = l51j3fqjqid9m3ee24uls1ui'
        )
      )
    ).toBe(true);
  });

  it('does not treat namespace deletion or overload as transient operation interruption', () => {
    expect(
      isPlatformTransientError(
        new Error('Durable Object Namespace was deleted')
      )
    ).toBe(false);
    expect(
      isPlatformTransientError({
        retryable: true,
        overloaded: true,
        toString: () => 'Durable Object is overloaded'
      })
    ).toBe(false);
  });
});

describe('matchContainerUnavailable', () => {
  it('classifies the platform no-instance error thrown during startup', () => {
    expect(
      matchContainerUnavailable(
        new Error(
          'there is no container instance that can be provided to this durable object'
        )
      )
    ).toBe('no_container_instance_available');
  });

  it('classifies the plain-text 503 no-instance body', () => {
    expect(
      matchContainerUnavailable(
        'There is no Container instance available at this time. Try again later.'
      )
    ).toBe('no_container_instance_available');
  });

  it('classifies the max-instances capacity error', () => {
    expect(
      matchContainerUnavailable(
        new Error(
          'Maximum number of running container instances exceeded. Try again later.'
        )
      )
    ).toBe('max_container_instances_exceeded');
  });

  it('matches case-insensitively and without instanceof (realm-safe)', () => {
    // A cross-realm error whose message is a plain property, not an Error.
    const crossRealm = {
      message:
        'THERE IS NO CONTAINER INSTANCE THAT CAN BE PROVIDED TO THIS DURABLE OBJECT'
    };
    expect(matchContainerUnavailable(crossRealm)).toBe(
      'no_container_instance_available'
    );
  });

  it('walks the cause chain to find a wrapped admission failure', () => {
    const cause = new Error(
      'there is no container instance that can be provided to this durable object'
    );
    expect(matchContainerUnavailable(new Error('wrapper', { cause }))).toBe(
      'no_container_instance_available'
    );
  });

  it('returns null for unrelated errors', () => {
    expect(matchContainerUnavailable(new Error('boom'))).toBeNull();
    expect(matchContainerUnavailable(undefined)).toBeNull();
  });
});
