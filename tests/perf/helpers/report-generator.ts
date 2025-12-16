/**
 * Generates console and JSON reports from collected metrics
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { METRICS, PASS_THRESHOLD, SCENARIOS } from './constants';
import type {
  GlobalMetricsStore,
  MeasurementStats,
  MetricsCollector
} from './metrics-collector';

export interface PerfTestResult {
  version: string;
  timestamp: string;
  runId: string;
  environment: {
    workerUrl: string;
    commitSha?: string;
    branch?: string;
    ci?: boolean;
  };
  duration: number;
  scenarios: ScenarioResult[];
  summary: SummaryResult;
}

export interface ScenarioResult {
  name: string;
  duration: number;
  metrics: MeasurementStats[];
  successRates: Record<
    string,
    { total: number; success: number; failure: number; rate: number }
  >;
  status: 'passed' | 'failed';
  error?: string;
}

export interface SummaryResult {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  keyMetrics: {
    coldStartP50?: number;
    coldStartP95?: number;
    concurrentSuccessRate?: number;
    sustainedThroughputP95?: number;
    burstSuccessRate?: number;
  };
}

export class ReportGenerator {
  private outputDir: string;

  constructor(outputDir: string = './perf-results') {
    this.outputDir = outputDir;
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generate console report for a single scenario
   */
  printScenarioReport(collector: MetricsCollector): void {
    const info = collector.getScenarioInfo();
    const stats = collector.getAllStats();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SCENARIO: ${info.name}`);
    console.log('='.repeat(60));
    console.log(`Duration: ${(info.duration / 1000).toFixed(2)}s`);
    console.log('');

    for (const stat of stats) {
      this.printMetricStats(stat);
      const successRate = collector.getSuccessRate(stat.name);
      if (successRate.total > 0) {
        console.log(
          `  Success Rate: ${successRate.rate.toFixed(1)}% (${successRate.success}/${successRate.total})`
        );
      }
      console.log('');
    }
  }

  /**
   * Print formatted metric statistics
   */
  private printMetricStats(stats: MeasurementStats): void {
    const format = (v: number): string => {
      if (stats.unit === 'ms') {
        return v < 1000 ? `${v.toFixed(1)}ms` : `${(v / 1000).toFixed(2)}s`;
      }
      return `${v.toFixed(2)} ${stats.unit}`;
    };

    console.log(`  ${stats.name} (n=${stats.count}):`);
    console.log(`    Min: ${format(stats.min)}  Max: ${format(stats.max)}`);
    console.log(
      `    Mean: ${format(stats.mean)}  StdDev: ${format(stats.stdDev)}`
    );
    console.log(
      `    P50: ${format(stats.p50)}  P90: ${format(stats.p90)}  P95: ${format(stats.p95)}  P99: ${format(stats.p99)}`
    );
  }

  /**
   * Generate full JSON report
   */
  generateJsonReport(
    store: GlobalMetricsStore,
    workerUrl: string
  ): PerfTestResult {
    const runInfo = store.getRunInfo();
    const scenarios: ScenarioResult[] = [];
    let passedCount = 0;
    let failedCount = 0;

    for (const [, collector] of store.getAllScenarios()) {
      const info = collector.getScenarioInfo();
      const metrics = collector.getAllStats();
      const successRates: Record<
        string,
        { total: number; success: number; failure: number; rate: number }
      > = {};

      for (const stat of metrics) {
        successRates[stat.name] = collector.getSuccessRate(stat.name);
      }

      // Determine pass/fail based on overall success rate
      const totalSuccess = Object.values(successRates).reduce(
        (sum, sr) => sum + sr.success,
        0
      );
      const totalCount = Object.values(successRates).reduce(
        (sum, sr) => sum + sr.total,
        0
      );
      const overallRate =
        totalCount > 0 ? (totalSuccess / totalCount) * 100 : 100;
      const status =
        overallRate >= PASS_THRESHOLD
          ? ('passed' as const)
          : ('failed' as const);

      if (status === 'passed') passedCount++;
      else failedCount++;

      scenarios.push({
        name: info.name,
        duration: info.duration,
        metrics,
        successRates,
        status
      });
    }

    const result: PerfTestResult = {
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      runId: `perf-${Date.now()}`,
      environment: {
        workerUrl,
        commitSha: process.env.GITHUB_SHA,
        branch: process.env.GITHUB_REF_NAME,
        ci: process.env.CI === 'true'
      },
      duration: runInfo.duration,
      scenarios,
      summary: {
        totalScenarios: scenarios.length,
        passedScenarios: passedCount,
        failedScenarios: failedCount,
        keyMetrics: this.extractKeyMetrics(scenarios)
      }
    };

    return result;
  }

  /**
   * Extract key metrics for summary
   */
  private extractKeyMetrics(
    scenarios: ScenarioResult[]
  ): SummaryResult['keyMetrics'] {
    const keyMetrics: SummaryResult['keyMetrics'] = {};

    // Cold start metrics
    const coldStartScenario = scenarios.find(
      (s) => s.name === SCENARIOS.COLD_START
    );
    if (coldStartScenario) {
      const coldStartMetric = coldStartScenario.metrics.find(
        (m) => m.name === METRICS.COLD_START_LATENCY
      );
      if (coldStartMetric) {
        keyMetrics.coldStartP50 = coldStartMetric.p50;
        keyMetrics.coldStartP95 = coldStartMetric.p95;
      }
    }

    // Concurrent creation metrics
    const concurrentScenario = scenarios.find(
      (s) => s.name === SCENARIOS.CONCURRENT
    );
    if (concurrentScenario) {
      const rate = concurrentScenario.successRates[METRICS.SANDBOX_CREATION];
      if (rate) {
        keyMetrics.concurrentSuccessRate = rate.rate;
      }
    }

    // Sustained throughput metrics
    const sustainedScenario = scenarios.find(
      (s) => s.name === SCENARIOS.SUSTAINED
    );
    if (sustainedScenario) {
      const throughputMetric = sustainedScenario.metrics.find(
        (m) => m.name === METRICS.COMMAND_LATENCY
      );
      if (throughputMetric) {
        keyMetrics.sustainedThroughputP95 = throughputMetric.p95;
      }
    }

    // Burst metrics
    const burstScenario = scenarios.find((s) => s.name === SCENARIOS.BURST);
    if (burstScenario) {
      const rate = burstScenario.successRates[METRICS.BURST_COMMAND];
      if (rate) {
        keyMetrics.burstSuccessRate = rate.rate;
      }
    }

    return keyMetrics;
  }

  /**
   * Write JSON report to file
   */
  writeJsonReport(report: PerfTestResult): string {
    const filename = `perf-results-${report.timestamp.replace(/[:.]/g, '-')}.json`;
    const filepath = join(this.outputDir, filename);
    writeFileSync(filepath, JSON.stringify(report, null, 2));

    // Also write latest.json for easy access
    const latestPath = join(this.outputDir, 'latest.json');
    writeFileSync(latestPath, JSON.stringify(report, null, 2));

    return filepath;
  }

  /**
   * Print final summary to console
   */
  printFinalSummary(report: PerfTestResult): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log('PERFORMANCE TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Duration: ${(report.duration / 1000).toFixed(2)}s`);
    console.log(
      `Scenarios: ${report.summary.passedScenarios}/${report.summary.totalScenarios} passed`
    );
    console.log('');
    console.log('Key Metrics:');
    const km = report.summary.keyMetrics;
    if (km.coldStartP50)
      console.log(`  Cold Start P50: ${km.coldStartP50.toFixed(0)}ms`);
    if (km.coldStartP95)
      console.log(`  Cold Start P95: ${km.coldStartP95.toFixed(0)}ms`);
    if (km.concurrentSuccessRate)
      console.log(
        `  Concurrent Creation Success: ${km.concurrentSuccessRate.toFixed(1)}%`
      );
    if (km.sustainedThroughputP95)
      console.log(
        `  Sustained Throughput P95: ${km.sustainedThroughputP95.toFixed(0)}ms`
      );
    if (km.burstSuccessRate)
      console.log(`  Burst Success Rate: ${km.burstSuccessRate.toFixed(1)}%`);
    console.log('='.repeat(60));
  }

  /**
   * Generate GitHub Actions Job Summary
   */
  generateGitHubSummary(report: PerfTestResult): string {
    const km = report.summary.keyMetrics;
    let summary = '## Performance Test Results\n\n';
    summary += `**Run ID:** ${report.runId}\n`;
    summary += `**Duration:** ${(report.duration / 1000).toFixed(2)}s\n`;
    summary += `**Scenarios:** ${report.summary.passedScenarios}/${report.summary.totalScenarios} passed\n\n`;

    summary += '### Key Metrics\n\n';
    summary += '| Metric | Value |\n';
    summary += '|--------|-------|\n';
    if (km.coldStartP50)
      summary += `| Cold Start P50 | ${km.coldStartP50.toFixed(0)}ms |\n`;
    if (km.coldStartP95)
      summary += `| Cold Start P95 | ${km.coldStartP95.toFixed(0)}ms |\n`;
    if (km.concurrentSuccessRate)
      summary += `| Concurrent Success | ${km.concurrentSuccessRate.toFixed(1)}% |\n`;
    if (km.sustainedThroughputP95)
      summary += `| Sustained P95 | ${km.sustainedThroughputP95.toFixed(0)}ms |\n`;
    if (km.burstSuccessRate)
      summary += `| Burst Success | ${km.burstSuccessRate.toFixed(1)}% |\n`;

    summary += '\n### Scenario Details\n\n';
    for (const scenario of report.scenarios) {
      const icon = scenario.status === 'passed' ? '✅' : '❌';
      summary += `<details>\n<summary>${icon} ${scenario.name}</summary>\n\n`;
      for (const metric of scenario.metrics) {
        summary += `**${metric.name}** (n=${metric.count})\n`;
        summary += `- P50: ${metric.p50.toFixed(0)}ms | P95: ${metric.p95.toFixed(0)}ms | P99: ${metric.p99.toFixed(0)}ms\n\n`;
      }
      summary += '</details>\n\n';
    }

    return summary;
  }
}
