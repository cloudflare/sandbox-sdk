/**
 * Represents a Promise-like object with a then method.
 * Used for detecting async results from vm.runInContext().
 */
export interface Thenable<T> {
  then: (
    onfulfilled?: (value: T) => unknown,
    onrejected?: (reason: unknown) => unknown
  ) => unknown;
}

/**
 * Type guard to check if a value is a thenable (Promise-like).
 * This is used to detect when vm.runInContext() returns a Promise
 * that needs to be awaited.
 */
export function isThenable(value: unknown): value is Thenable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as Thenable<unknown>).then === 'function'
  );
}
