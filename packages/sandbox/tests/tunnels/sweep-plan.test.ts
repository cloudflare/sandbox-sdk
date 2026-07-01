import { describe, expect, it } from 'vitest';
import type { DNSSummary, TunnelSummary } from '../../src/tunnels/inventory';
import {
  planDNSDeletes,
  planTunnelDeletes,
  resolveSweepTiming
} from '../../src/tunnels/sweep-plan';

const NOW = new Date('2026-05-26T12:00:00Z');
const ONE_DAY_MS = 24 * 60 * 60_000;
const THRESHOLD_MS = NOW.getTime() - ONE_DAY_MS;

function tunnel(overrides: Partial<TunnelSummary> = {}): TunnelSummary {
  return {
    id: 'tun-id',
    name: 'sandbox-sb-api',
    status: 'down',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    connsActiveAt: null,
    connsInactiveAt: null,
    deletedAt: null,
    metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb' },
    ...overrides
  };
}

function dns(overrides: Partial<DNSSummary> = {}): DNSSummary {
  return {
    id: 'rec-id',
    name: 'api.example.com',
    type: 'CNAME',
    content: 'missing-tun.cfargotunnel.com',
    comment: 'sandbox-sb',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides
  };
}

describe('resolveSweepTiming', () => {
  it('rejects non-positive stale windows', () => {
    expect(() => resolveSweepTiming({ staleAfterMs: 0, now: NOW })).toThrow(
      /staleAfterMs/i
    );
  });

  it('computes the threshold from the provided clock', () => {
    const timing = resolveSweepTiming({ staleAfterMs: ONE_DAY_MS, now: NOW });
    expect(timing.thresholdMs).toBe(THRESHOLD_MS);
  });
});

describe('planTunnelDeletes', () => {
  it.each([
    [
      'stale non-healthy tunnel',
      tunnel({
        id: 'old',
        connsInactiveAt: new Date(NOW.getTime() - 2 * ONE_DAY_MS)
      }),
      ['old']
    ],
    [
      'never-connected old tunnel',
      tunnel({
        id: 'ghost',
        status: 'inactive',
        createdAt: new Date(NOW.getTime() - 3 * ONE_DAY_MS),
        connsActiveAt: null,
        connsInactiveAt: null
      }),
      ['ghost']
    ],
    [
      'healthy tunnel with stale inactive timestamp',
      tunnel({
        id: 'healthy',
        status: 'healthy',
        connsInactiveAt: new Date(NOW.getTime() - 7 * ONE_DAY_MS)
      }),
      []
    ],
    [
      'recently inactive tunnel',
      tunnel({
        id: 'recent',
        connsInactiveAt: new Date(NOW.getTime() - 60_000)
      }),
      []
    ],
    [
      'recently reconnected tunnel',
      tunnel({
        id: 'reconnected',
        connsInactiveAt: new Date(NOW.getTime() - 5 * ONE_DAY_MS),
        connsActiveAt: new Date(NOW.getTime() - 60_000)
      }),
      []
    ],
    [
      'soft-deleted tunnel',
      tunnel({
        id: 'soft-deleted',
        deletedAt: new Date('2026-05-01T00:00:00Z')
      }),
      []
    ],
    [
      'tunnel without a valid timestamp',
      tunnel({
        id: 'unknown-age',
        createdAt: null,
        connsActiveAt: null,
        connsInactiveAt: null
      }),
      []
    ]
  ])('handles %s', (_label, input, expectedIds) => {
    const plan = planTunnelDeletes([input], THRESHOLD_MS);
    expect(plan.toDelete.map((t) => t.id)).toEqual(expectedIds);
    expect(plan.errors).toEqual([]);
  });

  it('does not scan or delete tunnels without identifying metadata', () => {
    const plan = planTunnelDeletes(
      [tunnel({ id: 'ambiguous', metadata: { createdBy: 'sandbox-sdk' } })],
      THRESHOLD_MS
    );
    expect(plan.toDelete).toEqual([]);
    expect(plan.scanned).toBe(0);
    expect(plan.errors).toEqual([
      {
        resource: 'tunnel',
        id: 'ambiguous',
        message: 'missing-identifying-metadata'
      }
    ]);
  });

  it('does not scan or delete unknown tunnel status values', () => {
    const plan = planTunnelDeletes(
      [
        tunnel({
          id: 'future-status',
          status: 'unknown',
          createdAt: new Date(NOW.getTime() - 2 * ONE_DAY_MS)
        })
      ],
      THRESHOLD_MS
    );
    expect(plan.toDelete).toEqual([]);
    expect(plan.scanned).toBe(0);
    expect(plan.errors).toEqual([
      {
        resource: 'tunnel',
        id: 'future-status',
        message: 'unknown-status'
      }
    ]);
  });
});

describe('planDNSDeletes', () => {
  it('plans deletion for old CNAMEs whose target tunnel is absent', () => {
    const plan = planDNSDeletes([dns()], new Set(['other-tun']), THRESHOLD_MS);
    expect(plan.scanned).toBe(1);
    expect(plan.toDelete).toEqual([{ id: 'rec-id', name: 'api.example.com' }]);
  });

  it('keeps DNS when the raw live tunnel id exists', () => {
    const plan = planDNSDeletes(
      [dns({ content: 'live-tun.cfargotunnel.com' })],
      new Set(['live-tun']),
      THRESHOLD_MS
    );
    expect(plan.toDelete).toEqual([]);
  });

  it('keeps DNS until its own age crosses the stale threshold', () => {
    const plan = planDNSDeletes(
      [dns({ createdAt: new Date(NOW.getTime() - 60_000) })],
      new Set(),
      THRESHOLD_MS
    );
    expect(plan.toDelete).toEqual([]);
  });

  it('keeps DNS when the creation timestamp is unavailable', () => {
    const plan = planDNSDeletes(
      [dns({ id: 'unknown-age', createdAt: null })],
      new Set(),
      THRESHOLD_MS
    );
    expect(plan.scanned).toBe(1);
    expect(plan.toDelete).toEqual([]);
  });
});
