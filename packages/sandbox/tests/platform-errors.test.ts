import { describe, expect, it } from 'vitest';
import {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError
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
