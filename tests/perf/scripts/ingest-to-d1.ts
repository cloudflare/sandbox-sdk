#!/usr/bin/env node
/**
 * Ingests a perf JSON report into Cloudflare D1.
 *
 * One-time setup (run once, then commit the database ID as a secret):
 *   wrangler d1 create perf-results
 *   wrangler d1 execute perf-results --remote --file tests/perf/schema.sql
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN   — CF API token with D1:Edit permission
 *   CLOUDFLARE_ACCOUNT_ID  — CF account ID
 *   PERF_D1_DATABASE_ID    — D1 database ID from `wrangler d1 create`
 *
 * Usage:
 *   npx tsx tests/perf/scripts/ingest-to-d1.ts [path/to/report.json] [--dry-run]
 *   (defaults to perf-results/latest.json)
 *
 * --dry-run  Print the SQL statements instead of posting to D1 (no credentials needed)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PerfTestResult } from '../helpers/report-generator';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REPORT_PATH = resolve(
  args.find((a) => !a.startsWith('--')) ?? 'perf-results/latest.json'
);
const DEFAULT_RETENTION_DAYS = 90;
const parsedRetentionDays = Number.parseInt(
  process.env.PERF_D1_RETENTION_DAYS ?? `${DEFAULT_RETENTION_DAYS}`,
  10
);
const RETENTION_DAYS =
  Number.isFinite(parsedRetentionDays) && parsedRetentionDays > 0
    ? parsedRetentionDays
    : DEFAULT_RETENTION_DAYS;

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PERF_D1_DATABASE_ID } =
  process.env;

if (
  !DRY_RUN &&
  (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !PERF_D1_DATABASE_ID)
) {
  console.error(
    '[D1 Ingest] Missing required env vars: ' +
      'CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, PERF_D1_DATABASE_ID\n' +
      '            (pass --dry-run to print SQL without credentials)'
  );
  process.exit(1);
}

if (!existsSync(REPORT_PATH)) {
  console.warn(`[D1 Ingest] Report not found at ${REPORT_PATH} — skipping`);
  process.exit(0);
}

const report: PerfTestResult = JSON.parse(readFileSync(REPORT_PATH, 'utf-8'));

interface D1Statement {
  sql: string;
  params: (string | number | null)[];
}

function buildStatements(report: PerfTestResult): D1Statement[] {
  const statements: D1Statement[] = [];

  const trigger =
    process.env.GITHUB_EVENT_NAME ??
    (process.env.CI ? 'workflow_dispatch' : 'local');
  const retentionCutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Upsert the run row
  statements.push({
    sql: `INSERT OR REPLACE INTO perf_runs
            (run_id, timestamp, commit_sha, branch, sdk_version,
             duration_ms, passed, total, worker_url, trigger)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      report.runId,
      report.timestamp,
      report.environment.commitSha ?? null,
      report.environment.branch ?? null,
      report.version,
      report.duration,
      report.summary.passedScenarios,
      report.summary.totalScenarios,
      report.environment.workerUrl ?? null,
      trigger
    ]
  });

  // Delete existing metrics for this run (idempotent re-ingest)
  statements.push({
    sql: 'DELETE FROM perf_metrics WHERE run_id = ?',
    params: [report.runId]
  });

  // Insert one row per metric per scenario
  for (const scenario of report.scenarios) {
    for (const metric of scenario.metrics) {
      statements.push({
        sql: `INSERT INTO perf_metrics
                (run_id, scenario, metric_name, unit, sample_count,
                 min_val, max_val, mean_val, p50, p75, p90, p95, p99, std_dev)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          report.runId,
          scenario.name,
          metric.name,
          metric.unit,
          metric.count,
          metric.min,
          metric.max,
          metric.mean,
          metric.p50,
          metric.p75,
          metric.p90,
          metric.p95,
          metric.p99,
          metric.stdDev
        ]
      });
    }
  }

  statements.push({
    sql: `DELETE FROM perf_metrics
          WHERE run_id IN (
            SELECT run_id FROM perf_runs WHERE timestamp < ?
          )`,
    params: [retentionCutoff]
  });

  statements.push({
    sql: 'DELETE FROM perf_runs WHERE timestamp < ?',
    params: [retentionCutoff]
  });

  return statements;
}

async function postStatement(statement: D1Statement): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${PERF_D1_DATABASE_ID}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql: statement.sql, params: statement.params })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`D1 API ${response.status}: ${text}`);
  }

  const body = (await response.json()) as {
    success: boolean;
    errors: { code: number; message: string }[];
    result: { success: boolean }[];
  };

  if (!body.success) {
    throw new Error(
      `D1 query failed: ${body.errors.map((e) => e.message).join(', ')}`
    );
  }

  if (body.result.some((result) => !result.success)) {
    throw new Error('Statement failed in D1 query response');
  }
}

async function postStatements(statements: D1Statement[]): Promise<void> {
  for (const statement of statements) {
    await postStatement(statement);
  }
}

const statements = buildStatements(report);
const metricCount = report.scenarios.reduce(
  (count, scenario) => count + scenario.metrics.length,
  0
);

console.log(
  `[D1 Ingest] run=${report.runId}  scenarios=${report.scenarios.length}  metrics=${metricCount}  retention=${RETENTION_DAYS}d`
);

if (DRY_RUN) {
  console.log('\n[D1 Ingest] DRY RUN — statements that would be sent:\n');
  for (const { sql, params } of statements) {
    console.log('  SQL:', sql.replace(/\s+/g, ' ').trim());
    console.log('  params:', JSON.stringify(params));
    console.log();
  }
  console.log(
    `[D1 Ingest] ${statements.length} statement(s) — not sent (dry run)`
  );
} else {
  await postStatements(statements);
  console.log(`[D1 Ingest] Done`);
}
