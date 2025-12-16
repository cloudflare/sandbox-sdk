/**
 * Global Teardown for Performance Tests
 *
 * Runs once after all test scenarios complete.
 * Generates final reports and stops wrangler dev if running locally.
 */

import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { PERF_STATE_FILE, runner } from './global-setup';
import { GlobalMetricsStore } from './helpers/metrics-collector';
import { ReportGenerator } from './helpers/report-generator';

export async function teardown() {
  console.log('\n[PerfTeardown] Generating final reports...');

  try {
    // Read state
    let workerUrl = process.env.TEST_WORKER_URL || '';
    if (existsSync(PERF_STATE_FILE)) {
      const state = JSON.parse(readFileSync(PERF_STATE_FILE, 'utf-8'));
      workerUrl = state.workerUrl || workerUrl;
    }

    // Generate reports
    const store = GlobalMetricsStore.getInstance();
    const reporter = new ReportGenerator('./perf-results');

    const report = reporter.generateJsonReport(store, workerUrl);
    const filepath = reporter.writeJsonReport(report);

    console.log(`[PerfTeardown] JSON report written to: ${filepath}`);

    // Print summary
    reporter.printFinalSummary(report);

    // Generate GitHub Actions summary if in CI
    if (process.env.GITHUB_STEP_SUMMARY) {
      const githubSummary = reporter.generateGitHubSummary(report);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, githubSummary);
      console.log('[PerfTeardown] GitHub summary written');
    }

    // Cleanup state file
    if (existsSync(PERF_STATE_FILE)) {
      unlinkSync(PERF_STATE_FILE);
    }
  } catch (error) {
    console.error('[PerfTeardown] Error generating reports:', error);
  }

  // Stop wrangler dev if we spawned it locally
  if (runner) {
    console.log('[PerfTeardown] Stopping wrangler dev...');
    await runner.stop();
  }

  console.log('[PerfTeardown] Done\n');
}
