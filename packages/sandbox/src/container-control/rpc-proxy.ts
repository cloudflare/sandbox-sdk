import type { ResourceActivityOperation } from '../resource-activity-gate';
import { translateRPCError } from './rpc-error';

export function createControlDomainProxy<T extends object>(
  getStub: () => T,
  domain: string,
  onCallStarted: () => ResourceActivityOperation,
  translateTransportErrorsAsInterruptions = true
): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, prop) {
      return (...args: unknown[]) => {
        const activity = onCallStarted();
        const operation =
          typeof prop === 'string' ? `${domain}.${prop}` : domain;
        const invoke = () => {
          try {
            const target = getStub();
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') {
              activity.finish();
              return value;
            }
            const result = Reflect.apply(
              value as (...a: unknown[]) => unknown,
              target,
              args
            );
            if (
              result != null &&
              typeof (result as { then?: unknown }).then === 'function'
            ) {
              return (result as Promise<unknown>)
                .catch((err: unknown) =>
                  translateRPCError(err, {
                    operation,
                    translateTransportErrorsAsInterruptions
                  })
                )
                .finally(activity.finish);
            }
            activity.finish();
            return result;
          } catch (err) {
            activity.finish();
            translateRPCError(err, {
              operation,
              translateTransportErrorsAsInterruptions
            });
          }
        };
        return activity.beforeCall.then(invoke, (err: unknown) => {
          activity.finish();
          throw err;
        });
      };
    }
  });
}
