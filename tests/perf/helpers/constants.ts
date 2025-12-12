/**
 * Constants for performance test scenarios and metrics
 */

export const SCENARIOS = {
  COLD_START: 'cold-start',
  CONCURRENT: 'concurrent-creation',
  SUSTAINED: 'sustained-throughput',
  BURST: 'bursty-traffic'
} as const;

export const METRICS = {
  // Cold start
  COLD_START_LATENCY: 'cold-start-latency',
  WARM_COMMAND_LATENCY: 'warm-command-latency',
  // Concurrent creation
  SANDBOX_CREATION: 'sandbox-creation',
  TOTAL_CONCURRENT_TIME: 'total-concurrent-time',
  SUCCESS_RATE: 'success-rate',
  // Sustained throughput
  COMMAND_LATENCY: 'command-latency',
  TOTAL_COMMANDS: 'total-commands',
  COMPLETED_COMMANDS: 'completed-commands',
  ACTUAL_THROUGHPUT: 'actual-throughput',
  LATENCY_DEGRADATION: 'latency-degradation',
  // Burst
  BURST_COMMAND: 'burst-command',
  BURST_DURATION: 'burst-duration',
  BURST_SUCCESS_RATE: 'burst-success-rate',
  BASELINE_LATENCY: 'baseline-latency',
  RECOVERY_LATENCY: 'recovery-latency',
  RECOVERY_OVERHEAD: 'recovery-overhead'
} as const;

/** Minimum success rate to pass a scenario (percentage) */
export const PASS_THRESHOLD = 80;
