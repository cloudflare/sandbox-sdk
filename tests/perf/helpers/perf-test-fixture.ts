/**
 * Shared test fixture for performance tests
 *
 * Eliminates boilerplate setup/teardown code across test scenarios.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PERF_SCENARIOS_FILE } from '../global-setup';
import { getWorkerUrl } from './get-worker-url';
import { GlobalMetricsStore, MetricsCollector } from './metrics-collector';
import { PerfSandboxManager } from './perf-sandbox-manager';
import { ReportGenerator, type ScenarioResult } from './report-generator';

export interface PerfTestContext {
  manager: PerfSandboxManager;
  collector: MetricsCollector;
  reporter: ReportGenerator;
  workerUrl: string;
}

/**
 * Create a test context with all necessary dependencies initialized.
 * Call this at the top of your describe() block.
 */
export function createPerfTestContext(scenarioName: string): PerfTestContext {
  const workerUrl = getWorkerUrl();
  return {
    workerUrl,
    manager: new PerfSandboxManager({ workerUrl }),
    collector: new MetricsCollector(scenarioName),
    reporter: new ReportGenerator()
  };
}

/**
 * Register scenario results with the global store and print report.
 * Call this in afterAll().
 */
export function registerPerfScenario(ctx: PerfTestContext): void {
  const scenario = ctx.reporter.generateScenarioResult(ctx.collector);
  const scenarios: ScenarioResult[] = existsSync(PERF_SCENARIOS_FILE)
    ? (JSON.parse(
        readFileSync(PERF_SCENARIOS_FILE, 'utf-8')
      ) as ScenarioResult[])
    : [];
  scenarios.push(scenario);
  writeFileSync(PERF_SCENARIOS_FILE, JSON.stringify(scenarios, null, 2));
  GlobalMetricsStore.getInstance().registerScenario(ctx.collector);
  ctx.reporter.printScenarioReport(ctx.collector);
}
