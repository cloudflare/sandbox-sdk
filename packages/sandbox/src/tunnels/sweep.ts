/**
 * Tunnel reconciler / stale-resource sweeper.
 *
 * Walks account and zone inventory, plans conservative deletions, then
 * executes each delete best-effort. Intended for Worker Cron Triggers.
 */

import { deleteDNSRecord, deleteTunnel } from './cloudflare-api';
import {
  type CloudflareCredentials,
  listSandboxDNSRecords,
  listTunnelInventory
} from './inventory';
import {
  planDNSDeletes,
  planTunnelDeletes,
  resolveSweepTiming,
  type SweepDeletionTarget,
  type SweepPlanningError
} from './sweep-plan';

/**
 * Outcome of a single sweep run. Shape is identical between dry-run and
 * destructive modes so operators can log and alert on the same fields.
 */
export interface SweepResult {
  /** SDK tunnel candidates evaluated for stale deletion. */
  tunnelsScanned: number;
  tunnelsDeleted: SweepDeletionTarget[];
  /** SDK-marked DNS records evaluated for orphan deletion. */
  dnsScanned: number;
  dnsDeleted: SweepDeletionTarget[];
  errors: SweepPlanningError[];
}

export interface SweepOptions {
  /** Threshold below which non-healthy resources are considered abandoned. */
  staleAfterMs: number;
  /** Restrict the sweep to a single sandbox. */
  sandboxId?: string;
  /** Compute the staleness threshold against this instant. */
  now?: Date;
  /** Report planned deletes without issuing Cloudflare DELETE calls. */
  dryRun?: boolean;
}

/**
 * Sweep stale SDK tunnels and orphan SDK CNAME records.
 *
 * DNS cleanup uses raw live tunnel IDs from the account inventory, not
 * just SDK-tagged tunnels. This makes DNS deletion conservative: a CNAME
 * is deleted only when its target tunnel is absent from the account's
 * live tunnel list and the record itself is older than the stale window.
 */
export async function sweepStale(
  creds: CloudflareCredentials,
  opts: SweepOptions
): Promise<SweepResult> {
  const { thresholdMs } = resolveSweepTiming(opts);
  const errors: SweepPlanningError[] = [];

  const tunnelInventory = await listTunnelInventory(creds, {
    sandboxId: opts.sandboxId,
    fetcher: creds.fetcher
  });
  const tunnelPlan = planTunnelDeletes(
    tunnelInventory.sandboxTunnels,
    thresholdMs
  );
  errors.push(...tunnelPlan.errors);

  const tunnelsDeleted = opts.dryRun
    ? tunnelPlan.toDelete
    : await deleteTunnels(creds, tunnelPlan.toDelete, errors);

  const dnsDeleted: SweepDeletionTarget[] = [];
  let dnsScanned = 0;
  if (creds.zoneId) {
    const dnsRecords = await listSandboxDNSRecords(creds, {
      sandboxId: opts.sandboxId,
      fetcher: creds.fetcher
    });
    const liveTunnelIds = new Set(tunnelInventory.liveTunnelIds);
    for (const deleted of tunnelsDeleted) {
      liveTunnelIds.delete(deleted.id);
    }
    const dnsPlan = planDNSDeletes(dnsRecords, liveTunnelIds, thresholdMs);
    dnsScanned = dnsPlan.scanned;
    dnsDeleted.push(
      ...(opts.dryRun
        ? dnsPlan.toDelete
        : await deleteDNSRecords(creds, dnsPlan.toDelete, errors))
    );
  }

  return {
    tunnelsScanned: tunnelPlan.scanned,
    tunnelsDeleted,
    dnsScanned,
    dnsDeleted,
    errors
  };
}

async function deleteTunnels(
  creds: CloudflareCredentials,
  targets: SweepDeletionTarget[],
  errors: SweepPlanningError[]
): Promise<SweepDeletionTarget[]> {
  const deleted: SweepDeletionTarget[] = [];
  for (const target of targets) {
    try {
      await deleteTunnel({
        token: creds.token,
        accountId: creds.accountId,
        tunnelId: target.id,
        fetcher: creds.fetcher
      });
      deleted.push(target);
    } catch (err) {
      errors.push({
        resource: 'tunnel',
        id: target.id,
        message: errorMessage(err)
      });
    }
  }
  return deleted;
}

async function deleteDNSRecords(
  creds: CloudflareCredentials,
  targets: SweepDeletionTarget[],
  errors: SweepPlanningError[]
): Promise<SweepDeletionTarget[]> {
  if (!creds.zoneId) return [];
  const deleted: SweepDeletionTarget[] = [];
  for (const target of targets) {
    try {
      await deleteDNSRecord({
        token: creds.token,
        zoneId: creds.zoneId,
        recordId: target.id,
        fetcher: creds.fetcher
      });
      deleted.push(target);
    } catch (err) {
      errors.push({
        resource: 'dns',
        id: target.id,
        message: errorMessage(err)
      });
    }
  }
  return deleted;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
