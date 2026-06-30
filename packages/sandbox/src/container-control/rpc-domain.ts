import { translateRPCError } from './errors';

export function createRPCDomain<T extends object>(
  getStub: () => T,
  domain: string,
  connect: () => Promise<void>,
  onCallStarted: () => void
): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;

      return async (...args: unknown[]) => {
        onCallStarted();
        await connect();

        const stub = getStub();
        const method = Reflect.get(stub, prop);
        if (typeof method !== 'function') {
          throw new TypeError(`RPC method ${domain}.${prop} is unavailable`);
        }

        const operation = `${domain}.${prop}`;
        try {
          const result = Reflect.apply(
            method as (...a: unknown[]) => unknown,
            stub,
            args
          );
          if (
            result != null &&
            typeof (result as { then?: unknown }).then === 'function'
          ) {
            return await (result as Promise<unknown>).catch((err: unknown) =>
              translateRPCError(err, { operation })
            );
          }
          return result;
        } catch (err) {
          translateRPCError(err, { operation });
        }
      };
    }
  });
}
