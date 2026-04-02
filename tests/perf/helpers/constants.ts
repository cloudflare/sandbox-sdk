/**
 * Constants for performance test scenarios and metrics
 */

export const SCENARIOS = {
  COLD_START: 'cold-start',
  CONCURRENT: 'concurrent-creation',
  SUSTAINED: 'sustained-throughput',
  BURST: 'bursty-traffic',
  BURST_STARTUP: 'burst-startup',
  FILE_IO: 'file-io'
} as const;

export const METRICS = {
  // Cold start / sequential startup (sequential create → first exec)
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
  // Bursty traffic (commands on a warm sandbox)
  BURST_COMMAND: 'burst-command',
  BURST_DURATION: 'burst-duration',
  BURST_SUCCESS_RATE: 'burst-success-rate',
  BASELINE_LATENCY: 'baseline-latency',
  RECOVERY_LATENCY: 'recovery-latency',
  RECOVERY_OVERHEAD: 'recovery-overhead',
  // Burst startup (rapid sandbox creations)
  BURST_STARTUP_LATENCY: 'burst-startup-latency',
  BURST_STARTUP_SUCCESS_RATE: 'burst-startup-success-rate',
  BURST_STARTUP_TOTAL_TIME: 'burst-startup-total-time',
  // File I/O — used as prefixes, appended with '-<size>' (e.g. 'file-write-latency-10kb')
  FILE_WRITE_LATENCY: 'file-write-latency',
  FILE_READ_LATENCY: 'file-read-latency',
  FILE_ROUNDTRIP_LATENCY: 'file-roundtrip-latency',
  FILE_CONCURRENT_WRITE: 'file-concurrent-write',
  FILE_CONCURRENT_READ: 'file-concurrent-read'
} as const;

/** Minimum success rate to pass a scenario (percentage) */
export const PASS_THRESHOLD = 80;
