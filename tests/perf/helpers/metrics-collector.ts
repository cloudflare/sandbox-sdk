/**
 * Metrics collection and statistical analysis for performance tests
 */

export interface Measurement {
  name: string;
  value: number;
  unit: 'ms' | 'ops/s' | 'count' | 'percent';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MeasurementStats {
  name: string;
  unit: 'ms' | 'ops/s' | 'count' | 'percent';
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export class MetricsCollector {
  private measurements: Map<string, Measurement[]> = new Map();
  private scenarioName: string;
  private startTime: number;

  constructor(scenarioName: string) {
    this.scenarioName = scenarioName;
    this.startTime = Date.now();
  }

  /**
   * Record a single measurement
   */
  record(
    name: string,
    value: number,
    unit: Measurement['unit'] = 'ms',
    metadata?: Record<string, unknown>
  ): void {
    const measurement: Measurement = {
      name,
      value,
      unit,
      timestamp: new Date().toISOString(),
      metadata
    };

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name)!.push(measurement);
  }

  /**
   * Time an async operation and record the result
   */
  async timeAsync<T>(
    name: string,
    operation: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<{ result: T; duration: number }> {
    const start = performance.now();
    try {
      const result = await operation();
      const duration = performance.now() - start;
      this.record(name, duration, 'ms', { ...metadata, success: true });
      return { result, duration };
    } catch (error) {
      const duration = performance.now() - start;
      this.record(name, duration, 'ms', {
        ...metadata,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Calculate statistics for a measurement series
   */
  getStats(name: string): MeasurementStats | null {
    const measurements = this.measurements.get(name);
    if (!measurements || measurements.length === 0) {
      return null;
    }

    const values = measurements.map((m) => m.value).sort((a, b) => a - b);
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / count;

    // Calculate standard deviation
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / count;
    const stdDev = Math.sqrt(avgSquaredDiff);

    // Linear interpolation for more accurate percentiles
    const percentile = (p: number): number => {
      if (count === 1) return values[0];
      const rank = (p / 100) * (count - 1);
      const lower = Math.floor(rank);
      const upper = Math.ceil(rank);
      const weight = rank - lower;
      return values[lower] * (1 - weight) + values[upper] * weight;
    };

    return {
      name,
      unit: measurements[0].unit,
      count,
      min: values[0],
      max: values[count - 1],
      mean,
      median: percentile(50),
      p50: percentile(50),
      p75: percentile(75),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      stdDev
    };
  }

  /**
   * Get all statistics
   */
  getAllStats(): MeasurementStats[] {
    const stats: MeasurementStats[] = [];
    for (const name of this.measurements.keys()) {
      const s = this.getStats(name);
      if (s) stats.push(s);
    }
    return stats;
  }

  /**
   * Get raw measurements for a metric
   */
  getMeasurements(name: string): Measurement[] {
    return this.measurements.get(name) || [];
  }

  /**
   * Get all raw measurements
   */
  getAllMeasurements(): Map<string, Measurement[]> {
    return new Map(this.measurements);
  }

  /**
   * Get scenario metadata
   */
  getScenarioInfo(): { name: string; startTime: number; duration: number } {
    return {
      name: this.scenarioName,
      startTime: this.startTime,
      duration: Date.now() - this.startTime
    };
  }

  /**
   * Count successes and failures
   */
  getSuccessRate(name: string): {
    total: number;
    success: number;
    failure: number;
    rate: number;
  } {
    const measurements = this.measurements.get(name) || [];
    const success = measurements.filter(
      (m) => m.metadata?.success === true
    ).length;
    const failure = measurements.filter(
      (m) => m.metadata?.success === false
    ).length;
    const total = measurements.length;
    return {
      total,
      success,
      failure,
      rate: total > 0 ? (success / total) * 100 : 0
    };
  }
}

/**
 * Global metrics store for cross-scenario aggregation
 */
export class GlobalMetricsStore {
  private static instance: GlobalMetricsStore;
  private scenarioResults: Map<string, MetricsCollector> = new Map();
  private runStartTime: number = Date.now();
  private runMetadata: Record<string, unknown> = {};

  static getInstance(): GlobalMetricsStore {
    if (!GlobalMetricsStore.instance) {
      GlobalMetricsStore.instance = new GlobalMetricsStore();
    }
    return GlobalMetricsStore.instance;
  }

  setRunMetadata(metadata: Record<string, unknown>): void {
    this.runMetadata = { ...this.runMetadata, ...metadata };
  }

  registerScenario(collector: MetricsCollector): void {
    const info = collector.getScenarioInfo();
    this.scenarioResults.set(info.name, collector);
  }

  getAllScenarios(): Map<string, MetricsCollector> {
    return this.scenarioResults;
  }

  getRunInfo(): {
    startTime: number;
    duration: number;
    metadata: Record<string, unknown>;
  } {
    return {
      startTime: this.runStartTime,
      duration: Date.now() - this.runStartTime,
      metadata: this.runMetadata
    };
  }

  reset(): void {
    this.scenarioResults.clear();
    this.runStartTime = Date.now();
    this.runMetadata = {};
  }
}
