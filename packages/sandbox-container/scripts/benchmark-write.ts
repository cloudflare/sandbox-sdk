import { randomBytes } from 'node:crypto';
import { createNoOpLogger, shellEscape } from '@repo/shared';
import type { ServiceResult, WriteOptions } from '../src/core/types';
import {
  FileService,
  type SecurityService
} from '../src/services/file-service';
import { SessionManager } from '../src/services/session-manager';
import type { RawExecResult } from '../src/session';

type Tier = 'core' | 'stress' | 'all';

interface BenchmarkCase {
  label: string;
  pathMode: 'absolute' | 'relative';
  encoding: 'utf-8' | 'base64';
  sizeBytes: number;
}

interface BenchmarkStats {
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  throughputMBps: number;
}

interface ParsedArgs {
  tier: Tier;
  warmupRuns: number;
  measuredRuns: number;
}

interface BenchmarkResultRow {
  label: string;
  sizeMB: number;
  encoding: 'utf-8' | 'base64';
  pathMode: 'absolute' | 'relative';
  legacy: BenchmarkStats;
  native: BenchmarkStats;
  speedup: number;
}

const SESSION_ID = 'benchmark-session';

const CORE_CASES: BenchmarkCase[] = [
  {
    label: 'utf8-1MB-abs',
    pathMode: 'absolute',
    encoding: 'utf-8',
    sizeBytes: 1 * 1024 * 1024
  },
  {
    label: 'utf8-1MB-rel',
    pathMode: 'relative',
    encoding: 'utf-8',
    sizeBytes: 1 * 1024 * 1024
  },
  {
    label: 'utf8-10MB-abs',
    pathMode: 'absolute',
    encoding: 'utf-8',
    sizeBytes: 10 * 1024 * 1024
  },
  {
    label: 'utf8-100MB-abs',
    pathMode: 'absolute',
    encoding: 'utf-8',
    sizeBytes: 100 * 1024 * 1024
  },
  {
    label: 'base64-1MB-abs',
    pathMode: 'absolute',
    encoding: 'base64',
    sizeBytes: 1 * 1024 * 1024
  },
  {
    label: 'base64-10MB-abs',
    pathMode: 'absolute',
    encoding: 'base64',
    sizeBytes: 10 * 1024 * 1024
  },
  {
    label: 'base64-100MB-abs',
    pathMode: 'absolute',
    encoding: 'base64',
    sizeBytes: 100 * 1024 * 1024
  }
];

const STRESS_CASES: BenchmarkCase[] = [
  {
    label: 'utf8-500MB-abs',
    pathMode: 'absolute',
    encoding: 'utf-8',
    sizeBytes: 500 * 1024 * 1024
  },
  {
    label: 'base64-500MB-abs',
    pathMode: 'absolute',
    encoding: 'base64',
    sizeBytes: 500 * 1024 * 1024
  }
];

function percentile(sortedValues: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))];
}

function computeStats(timesMs: number[], payloadBytes: number): BenchmarkStats {
  const sorted = [...timesMs].sort((a, b) => a - b);
  const sum = timesMs.reduce((acc, cur) => acc + cur, 0);
  const avgMs = sum / timesMs.length;
  const medianMs = percentile(sorted, 50);
  const p95Ms = percentile(sorted, 95);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];

  const avgSeconds = avgMs / 1000;
  const throughputMBps = payloadBytes / (1024 * 1024) / avgSeconds;

  return {
    avgMs,
    medianMs,
    p95Ms,
    minMs,
    maxMs,
    throughputMBps
  };
}

function format(n: number): string {
  return n.toFixed(2);
}

function parseTier(value: string | undefined): Tier {
  if (!value) return 'core';
  if (value === 'core' || value === 'stress' || value === 'all') {
    return value;
  }
  throw new Error(`Invalid --tier value '${value}'. Use core|stress|all.`);
}

function parseNumberArg(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid --${name} value '${value}'. Use a non-negative integer.`
    );
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const kv = new Map<string, string>();

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    if (key && value !== undefined) {
      kv.set(key, value);
    }
  }

  const tier = parseTier(kv.get('tier'));

  const defaultWarmup = tier === 'stress' ? 0 : 1;
  const defaultMeasured = tier === 'stress' ? 1 : 3;

  const warmupRuns = parseNumberArg(kv.get('warmup'), defaultWarmup, 'warmup');
  const measuredRuns = parseNumberArg(kv.get('runs'), defaultMeasured, 'runs');

  return { tier, warmupRuns, measuredRuns };
}

function getCases(tier: Tier): BenchmarkCase[] {
  if (tier === 'core') return CORE_CASES;
  if (tier === 'stress') return STRESS_CASES;
  return [...CORE_CASES, ...STRESS_CASES];
}

function renderMarkdownTable(results: BenchmarkResultRow[]): string {
  const header = [
    '| Case | Size | Encoding | Path | Legacy avg (ms) | Native avg (ms) | Speedup | Legacy MB/s | Native MB/s |',
    '| :--- | ---: | :--- | :--- | ---: | ---: | ---: | ---: | ---: |'
  ];

  const rows = results.map((row) => {
    return `| ${row.label} | ${row.sizeMB}MB | ${row.encoding} | ${row.pathMode} | ${format(row.legacy.avgMs)} | ${format(row.native.avgMs)} | ${format(row.speedup)}x | ${format(row.legacy.throughputMBps)} | ${format(row.native.throughputMBps)} |`;
  });

  return [...header, ...rows].join('\n');
}

async function legacyWrite(
  sessionManager: SessionManager,
  path: string,
  content: string,
  options: WriteOptions = {},
  sessionId = SESSION_ID
): Promise<void> {
  const escapedPath = shellEscape(path);
  const normalizedEncoding =
    options.encoding === 'utf8' ? 'utf-8' : options.encoding || 'utf-8';

  let command: string;
  if (normalizedEncoding === 'base64') {
    if (!/^[A-Za-z0-9+/=]*$/.test(content)) {
      throw new Error('Invalid base64 input');
    }
    command = `printf '%s' '${content}' | base64 -d > ${escapedPath}`;
  } else {
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');
    command = `printf '%s' '${base64Content}' | base64 -d > ${escapedPath}`;
  }

  const result = (await sessionManager.executeInSession(
    sessionId,
    command
  )) as ServiceResult<RawExecResult>;

  if (!result.success) {
    throw new Error(result.error.message);
  }

  if (result.data.exitCode !== 0) {
    throw new Error(result.data.stderr || `Exit code ${result.data.exitCode}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const logger = createNoOpLogger();
  const security: SecurityService = {
    validatePath: () => ({ isValid: true, errors: [] })
  };

  const sessionManager = new SessionManager(logger);
  const fileService = new FileService(security, logger, sessionManager);

  const absDir = `/tmp/sandbox-bench-${Date.now()}`;
  const relDir = `sandbox-bench-${Date.now()}`;
  const cases = getCases(args.tier);
  const results: BenchmarkResultRow[] = [];

  try {
    await sessionManager.executeInSession(
      SESSION_ID,
      `mkdir -p ${shellEscape(absDir)}`
    );
    await sessionManager.executeInSession(
      SESSION_ID,
      `mkdir -p ${shellEscape(relDir)}`
    );

    console.log(
      '\nWrite benchmark (legacy shell pipeline vs native Bun.write)'
    );
    console.log(
      `Tier: ${args.tier} | Warmup: ${args.warmupRuns} | Measured: ${args.measuredRuns} | Session: ${SESSION_ID}`
    );

    for (const benchCase of cases) {
      const rawBytes = randomBytes(benchCase.sizeBytes);

      const payload =
        benchCase.encoding === 'base64'
          ? rawBytes.toString('base64')
          : 'a'.repeat(benchCase.sizeBytes);

      const filename = `${benchCase.label}.dat`;
      const path =
        benchCase.pathMode === 'absolute'
          ? `${absDir}/${filename}`
          : `${relDir}/${filename}`;

      for (let i = 0; i < args.warmupRuns; i++) {
        await legacyWrite(
          sessionManager,
          path,
          payload,
          { encoding: benchCase.encoding },
          SESSION_ID
        );
        await fileService.write(
          path,
          payload,
          { encoding: benchCase.encoding },
          SESSION_ID
        );
      }

      const legacyTimes: number[] = [];
      const nativeTimes: number[] = [];

      for (let i = 0; i < args.measuredRuns; i++) {
        const startLegacy = performance.now();
        await legacyWrite(
          sessionManager,
          path,
          payload,
          { encoding: benchCase.encoding },
          SESSION_ID
        );
        legacyTimes.push(performance.now() - startLegacy);

        const startNative = performance.now();
        const result = await fileService.write(
          path,
          payload,
          { encoding: benchCase.encoding },
          SESSION_ID
        );
        if (!result.success) {
          throw new Error(result.error.message);
        }
        nativeTimes.push(performance.now() - startNative);
      }

      const payloadBytes = benchCase.sizeBytes;
      const legacyStats = computeStats(legacyTimes, payloadBytes);
      const nativeStats = computeStats(nativeTimes, payloadBytes);
      const speedup = legacyStats.avgMs / nativeStats.avgMs;

      results.push({
        label: benchCase.label,
        sizeMB: Math.floor(benchCase.sizeBytes / (1024 * 1024)),
        encoding: benchCase.encoding,
        pathMode: benchCase.pathMode,
        legacy: legacyStats,
        native: nativeStats,
        speedup
      });

      console.log(`\nCase: ${benchCase.label}`);
      console.log(
        `  Legacy avg=${format(legacyStats.avgMs)}ms p95=${format(legacyStats.p95Ms)}ms throughput=${format(legacyStats.throughputMBps)}MB/s`
      );
      console.log(
        `  Native avg=${format(nativeStats.avgMs)}ms p95=${format(nativeStats.p95Ms)}ms throughput=${format(nativeStats.throughputMBps)}MB/s`
      );
      console.log(`  Speedup: ${format(speedup)}x`);
    }

    console.log('\nPR-ready markdown summary:\n');
    console.log(renderMarkdownTable(results));
  } finally {
    await sessionManager.destroy();
  }
}

await main();
