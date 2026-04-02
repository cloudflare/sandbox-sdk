-- Performance benchmark schema for Cloudflare D1
--
-- One-time setup:
--   wrangler d1 create perf-results
--   wrangler d1 execute perf-results --remote --file tests/perf/schema.sql

CREATE TABLE IF NOT EXISTS perf_runs (
  run_id      TEXT    PRIMARY KEY,
  timestamp   TEXT    NOT NULL,
  commit_sha  TEXT,
  branch      TEXT,
  sdk_version TEXT,
  duration_ms INTEGER NOT NULL,
  passed      INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  worker_url  TEXT,
  trigger     TEXT    -- 'schedule' | 'release' | 'workflow_dispatch' | 'local'
);

CREATE TABLE IF NOT EXISTS perf_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL REFERENCES perf_runs(run_id),
  scenario     TEXT    NOT NULL,
  metric_name  TEXT    NOT NULL,
  unit         TEXT    NOT NULL,
  sample_count INTEGER NOT NULL,
  min_val      REAL,
  max_val      REAL,
  mean_val     REAL,
  p50          REAL,
  p75          REAL,
  p90          REAL,
  p95          REAL,
  p99          REAL,
  std_dev      REAL
);

CREATE INDEX IF NOT EXISTS idx_metrics_run      ON perf_metrics (run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_scenario ON perf_metrics (scenario, metric_name);
CREATE INDEX IF NOT EXISTS idx_runs_timestamp   ON perf_runs    (timestamp);
