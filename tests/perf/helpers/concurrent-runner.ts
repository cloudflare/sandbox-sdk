/**
 * Utilities for running concurrent operations with controlled parallelism
 */

export interface ConcurrentResult<T> {
  results: Array<
    | { index: number; result: T; duration: number }
    | { index: number; error: Error; duration: number }
  >;
  totalDuration: number;
  successCount: number;
  failureCount: number;
}

/**
 * Run operations concurrently with optional batching
 */
export async function runConcurrent<T>(
  operations: Array<() => Promise<T>>,
  options?: {
    maxConcurrency?: number; // Limit concurrent operations
    delayBetweenBatches?: number; // ms delay between batches
  }
): Promise<ConcurrentResult<T>> {
  const maxConcurrency = options?.maxConcurrency || operations.length;
  const delayMs = options?.delayBetweenBatches || 0;

  const start = performance.now();
  const results: ConcurrentResult<T>['results'] = [];
  let successCount = 0;
  let failureCount = 0;

  // Process in batches if concurrency is limited
  for (let i = 0; i < operations.length; i += maxConcurrency) {
    const batch = operations.slice(i, i + maxConcurrency);
    const batchStartIndex = i;

    if (i > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const batchResults = await Promise.allSettled(
      batch.map(async (op, batchIndex) => {
        const opStart = performance.now();
        try {
          const result = await op();
          const duration = performance.now() - opStart;
          return { index: batchStartIndex + batchIndex, result, duration };
        } catch (error) {
          const duration = performance.now() - opStart;
          throw { index: batchStartIndex + batchIndex, error, duration };
        }
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        successCount++;
      } else {
        const rejected = result.reason as {
          index: number;
          error: Error;
          duration: number;
        };
        results.push({
          index: rejected.index,
          error: rejected.error,
          duration: rejected.duration
        });
        failureCount++;
      }
    }
  }

  return {
    results: results.sort((a, b) => a.index - b.index),
    totalDuration: performance.now() - start,
    successCount,
    failureCount
  };
}

/**
 * Create a burst of operations with staggered starts
 */
export async function runBurst<T>(
  operation: () => Promise<T>,
  count: number,
  options?: {
    staggerMs?: number; // Delay between operation starts
    maxDuration?: number; // Max time to wait for all operations
  }
): Promise<ConcurrentResult<T>> {
  const staggerMs = options?.staggerMs || 10;
  const maxDuration = options?.maxDuration || 120000;

  const start = performance.now();
  const promises: Promise<
    | { index: number; result: T; duration: number }
    | { index: number; error: Error; duration: number }
  >[] = [];

  for (let i = 0; i < count; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerMs));
    }

    const index = i;
    const opStart = performance.now();

    promises.push(
      operation()
        .then((result) => ({
          index,
          result,
          duration: performance.now() - opStart
        }))
        .catch((error) => ({
          index,
          error: error as Error,
          duration: performance.now() - opStart
        }))
    );
  }

  // Wait for all with timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Burst timeout')), maxDuration);
  });

  try {
    const results = await Promise.race([Promise.all(promises), timeoutPromise]);

    let successCount = 0;
    let failureCount = 0;
    for (const r of results) {
      if ('result' in r) successCount++;
      else failureCount++;
    }

    return {
      results,
      totalDuration: performance.now() - start,
      successCount,
      failureCount
    };
  } catch {
    // Timeout - return partial results
    const settled = await Promise.allSettled(promises);
    let successCount = 0;
    let failureCount = 0;
    const results: ConcurrentResult<T>['results'] = [];

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
        if ('result' in s.value) successCount++;
        else failureCount++;
      }
    }

    return {
      results,
      totalDuration: performance.now() - start,
      successCount,
      failureCount
    };
  }
}
