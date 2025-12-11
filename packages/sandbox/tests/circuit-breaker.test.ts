import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitState
} from '../src/clients/circuit-breaker';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      failureWindow: 10_000, // 10 seconds
      recoveryTimeout: 5_000, // 5 seconds
      successThreshold: 2
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in closed state', () => {
      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should allow requests when closed', () => {
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should have correct initial stats', () => {
      const stats = circuitBreaker.getStats();
      expect(stats.state).toBe('closed');
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.remainingRecoveryMs).toBeNull();
    });
  });

  describe('failure tracking', () => {
    it('should track failures', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(2);
      expect(stats.state).toBe('closed'); // Still below threshold
    });

    it('should open circuit when failure threshold is reached', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('open');
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should clear old failures outside the window', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Advance past the failure window
      vi.advanceTimersByTime(11_000);

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(0);
    });

    it('should not open circuit if failures are spread across windows', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      vi.advanceTimersByTime(11_000); // Past first failures

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Only 2 failures in current window, below threshold
      expect(circuitBreaker.getState()).toBe('closed');
    });
  });

  describe('state transitions', () => {
    it('should transition to half-open after recovery timeout', () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('open');

      // Advance past recovery timeout
      vi.advanceTimersByTime(6_000);

      // Check canExecute triggers transition to half-open
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('half-open');
    });

    it('should close circuit after success threshold in half-open', () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Wait for recovery
      vi.advanceTimersByTime(6_000);
      circuitBreaker.canExecute(); // Triggers half-open

      // Record successes
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('half-open');

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should reopen circuit on failure in half-open state', () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Wait for recovery
      vi.advanceTimersByTime(6_000);
      circuitBreaker.canExecute(); // Triggers half-open

      // Record a failure
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('open');
    });

    it('should notify on state changes', () => {
      const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];

      circuitBreaker = new CircuitBreaker({
        failureThreshold: 2,
        recoveryTimeout: 5_000,
        successThreshold: 1,
        onStateChange: (to, from) => {
          transitions.push({ from, to });
        }
      });

      // Trigger closed -> open
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({ from: 'closed', to: 'open' });

      // Trigger open -> half-open
      vi.advanceTimersByTime(6_000);
      circuitBreaker.canExecute();

      expect(transitions).toHaveLength(2);
      expect(transitions[1]).toEqual({ from: 'open', to: 'half-open' });

      // Trigger half-open -> closed
      circuitBreaker.recordSuccess();

      expect(transitions).toHaveLength(3);
      expect(transitions[2]).toEqual({ from: 'half-open', to: 'closed' });
    });
  });

  describe('execute method', () => {
    it('should execute function when circuit is closed', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      const result = await circuitBreaker.execute(fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    it('should record success on successful execution', async () => {
      const fn = vi.fn().mockResolvedValue('result');

      await circuitBreaker.execute(fn);

      // Open circuit first to test half-open behavior
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      vi.advanceTimersByTime(6_000);
      circuitBreaker.canExecute(); // half-open

      await circuitBreaker.execute(fn);
      await circuitBreaker.execute(fn);

      expect(circuitBreaker.getState()).toBe('closed');
    });

    it('should record failure on failed execution', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');
      await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');

      expect(circuitBreaker.getState()).toBe('open');
    });

    it('should throw CircuitOpenError when circuit is open', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const fn = vi.fn().mockResolvedValue('result');

      await expect(circuitBreaker.execute(fn)).rejects.toThrow(
        CircuitOpenError
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('should include remaining recovery time in CircuitOpenError', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Advance partway through recovery
      vi.advanceTimersByTime(2_000);

      const fn = vi.fn().mockResolvedValue('result');

      try {
        await circuitBreaker.execute(fn);
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitOpenError);
        expect((error as CircuitOpenError).remainingMs).toBeCloseTo(3_000, -2);
      }
    });
  });

  describe('reset', () => {
    it('should reset circuit to closed state', () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('open');

      circuitBreaker.reset();

      expect(circuitBreaker.getState()).toBe('closed');
      expect(circuitBreaker.getStats().failureCount).toBe(0);
    });
  });

  describe('default options', () => {
    it('should use sensible defaults', () => {
      const defaultBreaker = new CircuitBreaker();

      // Record 5 failures (default threshold)
      for (let i = 0; i < 5; i++) {
        defaultBreaker.recordFailure();
      }

      expect(defaultBreaker.getState()).toBe('open');
    });
  });
});
