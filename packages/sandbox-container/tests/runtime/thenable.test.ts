import { describe, expect, it } from 'bun:test';
import { isThenable } from '../../src/runtime/executors/shared/thenable';

describe('isThenable', () => {
  describe('returns true for Promise-like values', () => {
    it('native Promise', () => {
      expect(isThenable(Promise.resolve(42))).toBe(true);
    });

    it('Promise created with new Promise()', () => {
      const promise = new Promise((resolve) => resolve('test'));
      expect(isThenable(promise)).toBe(true);
    });

    it('async function result', async () => {
      const asyncFn = async () => 42;
      const result = asyncFn();
      expect(isThenable(result)).toBe(true);
    });

    it('object with then method', () => {
      // biome-ignore lint/suspicious/noThenProperty: Testing thenable detection requires creating objects with `then`
      const thenable = { then: () => {} };
      expect(isThenable(thenable)).toBe(true);
    });

    it('custom thenable with proper signature', () => {
      const customThenable = {
        // biome-ignore lint/suspicious/noThenProperty: Testing thenable detection requires creating objects with `then`
        then: (onFulfilled?: (value: number) => void) => {
          if (onFulfilled) onFulfilled(42);
        }
      };
      expect(isThenable(customThenable)).toBe(true);
    });
  });

  describe('returns false for non-Promise-like values', () => {
    it('null', () => {
      expect(isThenable(null)).toBe(false);
    });

    it('undefined', () => {
      expect(isThenable(undefined)).toBe(false);
    });

    it('number', () => {
      expect(isThenable(42)).toBe(false);
    });

    it('string', () => {
      expect(isThenable('hello')).toBe(false);
    });

    it('boolean', () => {
      expect(isThenable(true)).toBe(false);
    });

    it('regular object without then', () => {
      expect(isThenable({ foo: 'bar' })).toBe(false);
    });

    it('array', () => {
      expect(isThenable([1, 2, 3])).toBe(false);
    });

    it('function', () => {
      expect(isThenable(() => {})).toBe(false);
    });

    it('object with non-function then property', () => {
      // biome-ignore lint/suspicious/noThenProperty: Testing thenable detection requires creating objects with `then`
      expect(isThenable({ then: 'not a function' })).toBe(false);
    });

    it('object with then as number', () => {
      // biome-ignore lint/suspicious/noThenProperty: Testing thenable detection requires creating objects with `then`
      expect(isThenable({ then: 42 })).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejected Promise', () => {
      const rejected = Promise.reject(new Error('test'));
      expect(isThenable(rejected)).toBe(true);
      // Clean up unhandled rejection
      rejected.catch(() => {});
    });

    it('Promise.all result', () => {
      const promiseAll = Promise.all([Promise.resolve(1)]);
      expect(isThenable(promiseAll)).toBe(true);
    });

    it('Promise.race result', () => {
      const promiseRace = Promise.race([Promise.resolve(1)]);
      expect(isThenable(promiseRace)).toBe(true);
    });
  });
});
