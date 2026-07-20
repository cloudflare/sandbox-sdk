import { translateRPCError } from './rpc-error';

export function createControlDomainProxy<T extends object>(
  getStub: () => T,
  domain: string,
  translateTransportErrorsAsInterruptions = true
): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, prop) {
      return (...args: unknown[]) => {
        const operation =
          typeof prop === 'string' ? `${domain}.${prop}` : domain;
        try {
          const target = getStub();
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          const result = Reflect.apply(
            value as (...a: unknown[]) => unknown,
            target,
            args
          );
          if (
            result != null &&
            typeof (result as { then?: unknown }).then === 'function'
          ) {
            return (result as Promise<unknown>).catch((err: unknown) =>
              translateRPCError(err, {
                operation,
                translateTransportErrorsAsInterruptions
              })
            );
          }
          return result;
        } catch (err) {
          translateRPCError(err, {
            operation,
            translateTransportErrorsAsInterruptions
          });
        }
      };
    }
  });
}
