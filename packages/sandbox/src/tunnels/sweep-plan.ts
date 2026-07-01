/** Pure deletion planning for tunnel cleanup sweeps. */

import type { DNSSummary, TunnelSummary } from './inventory';

export interface SweepDeletionTarget {
  id: string;
  name: string;
}

export interface SweepPlanningError {
  resource: 'tunnel' | 'dns';
  id: string;
  message: string;
}

export interface TunnelDeletePlan {
  scanned: number;
  toDelete: SweepDeletionTarget[];
  errors: SweepPlanningError[];
}

export interface DNSDeletePlan {
  scanned: number;
  toDelete: SweepDeletionTarget[];
}

export interface SweepTimingOptions {
  staleAfterMs: number;
  now?: Date;
}

interface ResolvedTiming {
  now: Date;
  thresholdMs: number;
}

export function resolveSweepTiming(opts: SweepTimingOptions): ResolvedTiming {
  validateStaleAfterMs(opts.staleAfterMs);
  const now = opts.now ?? new Date();
  return {
    now,
    thresholdMs: now.getTime() - opts.staleAfterMs
  };
}

export function validateStaleAfterMs(staleAfterMs: number): void {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('staleAfterMs must be a finite number greater than 0');
  }
}

export function planTunnelDeletes(
  tunnels: TunnelSummary[],
  thresholdMs: number
): TunnelDeletePlan {
  const errors: SweepPlanningError[] = [];
  const candidates: TunnelSummary[] = [];

  for (const tunnel of tunnels) {
    const meta = tunnel.metadata ?? {};
    if (typeof meta.sandboxId !== 'string' || meta.sandboxId.length === 0) {
      errors.push({
        resource: 'tunnel',
        id: tunnel.id,
        message: 'missing-identifying-metadata'
      });
      continue;
    }
    if (tunnel.status === 'unknown') {
      errors.push({
        resource: 'tunnel',
        id: tunnel.id,
        message: 'unknown-status'
      });
      continue;
    }
    candidates.push(tunnel);
  }

  return {
    scanned: candidates.length,
    toDelete: candidates
      .filter((tunnel) => isTunnelStale(tunnel, thresholdMs))
      .map((tunnel) => ({ id: tunnel.id, name: tunnel.name })),
    errors
  };
}

export function planDNSDeletes(
  records: DNSSummary[],
  liveTunnelIds: Set<string>,
  thresholdMs: number
): DNSDeletePlan {
  return {
    scanned: records.length,
    toDelete: records
      .filter((record) => isOldOrphanCNAME(record, liveTunnelIds, thresholdMs))
      .map((record) => ({ id: record.id, name: record.name }))
  };
}

function isTunnelStale(tunnel: TunnelSummary, thresholdMs: number): boolean {
  if (tunnel.deletedAt) return false;
  if (tunnel.status === 'healthy') return false;

  const mostRecent = mostRecentTimestamp([
    tunnel.connsActiveAt,
    tunnel.connsInactiveAt,
    tunnel.createdAt
  ]);
  if (mostRecent === null) return false;
  return mostRecent < thresholdMs;
}

function mostRecentTimestamp(dates: Array<Date | null>): number | null {
  const timestamps = dates
    .map((date) => date?.getTime())
    .filter(
      (value): value is number =>
        typeof value === 'number' && Number.isFinite(value)
    );
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function isOldOrphanCNAME(
  record: DNSSummary,
  liveTunnelIds: Set<string>,
  thresholdMs: number
): boolean {
  if (record.type !== 'CNAME') return false;
  const createdAt = record.createdAt?.getTime();
  if (createdAt === undefined || !Number.isFinite(createdAt)) return false;
  if (createdAt >= thresholdMs) return false;

  const match = /^([^.]+)\.cfargotunnel\.com$/.exec(record.content);
  if (!match) return false;
  return !liveTunnelIds.has(match[1]);
}
