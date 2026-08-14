import { aggregateReleaseFailures } from './release-errors.ts';
import { inspectStableRelease } from './release-inspect.ts';
import {
  planStableRelease,
  type ReleaseOperation,
  type StableReleasePlan
} from './release-plan.ts';
import type { ReleasePlatform } from './release-platform.ts';
import type { StableReleaseContext } from './stable-release-context.ts';
import type { PreparedRelease } from './stable-release-preparation.ts';

export interface StableEngineInput {
  context: StableReleaseContext;
  platform: ReleasePlatform;
  prepare(): Promise<PreparedRelease>;
  reinspectionDelay?(): Promise<void>;
}

export interface StableEngineResult {
  initialPlan: StableReleasePlan;
  finalPlan: StableReleasePlan;
  reinspectionComplete: boolean;
}

export async function inspectStableReleasePlan(
  input: StableEngineInput
): Promise<StableReleasePlan> {
  const prepared = await input.prepare();
  let primaryError: unknown;
  try {
    const inspection = await inspectStableRelease(
      input.context,
      prepared,
      input.platform
    );
    return planStableRelease(input.context, inspection, prepared);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPreparedRelease(prepared, primaryError);
  }
}

export async function runStableReleaseEngine(
  input: StableEngineInput
): Promise<StableEngineResult> {
  const prepared = await input.prepare();
  let primaryError: unknown;
  try {
    const inspection = await inspectStableRelease(
      input.context,
      prepared,
      input.platform
    );
    const initialPlan = planStableRelease(input.context, inspection, prepared);
    aggregateReleaseFailures('plan', initialPlan.conflicts);

    await applyStableReleasePlan(initialPlan, input.platform);

    const finalPlan = await reinspectUntilComplete(input, prepared);
    if (finalPlan.operations.length > 0) {
      throw new Error(
        `Stable release reinspection found missing state:\n${finalPlan.operations
          .map((operation) => operation.type)
          .join('\n')}`
      );
    }

    return { initialPlan, finalPlan, reinspectionComplete: true };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPreparedRelease(prepared, primaryError);
  }
}

const REINSPECTION_ATTEMPTS = 7;
const REINSPECTION_DELAY_MS = 5_000;

async function reinspectUntilComplete(
  input: StableEngineInput,
  prepared: PreparedRelease
): Promise<StableReleasePlan> {
  let finalPlan: StableReleasePlan | undefined;

  for (let attempt = 1; attempt <= REINSPECTION_ATTEMPTS; attempt += 1) {
    const reinspection = await inspectStableRelease(
      input.context,
      prepared,
      input.platform
    );
    finalPlan = planStableRelease(input.context, reinspection, prepared);
    aggregateReleaseFailures('reinspect', finalPlan.conflicts);
    if (finalPlan.operations.length === 0) return finalPlan;
    if (attempt < REINSPECTION_ATTEMPTS) {
      await (input.reinspectionDelay ?? defaultReinspectionDelay)();
    }
  }

  if (finalPlan === undefined)
    throw new Error('Stable release not reinspected');
  return finalPlan;
}

async function defaultReinspectionDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, REINSPECTION_DELAY_MS));
}

async function cleanupPreparedRelease(
  prepared: PreparedRelease,
  primaryError: unknown
): Promise<void> {
  try {
    await prepared.cleanup();
  } catch (cleanupError) {
    if (primaryError === undefined) {
      throw cleanupError;
    }
    throw new AggregateError(
      [primaryError, cleanupError],
      primaryError instanceof Error
        ? primaryError.message
        : 'Stable release failed and cleanup also failed'
    );
  }
}

async function applyStableReleasePlan(
  plan: StableReleasePlan,
  platform: ReleasePlatform
): Promise<void> {
  for (const operation of plan.operations) {
    await applyOperation(operation, platform);
  }
}

async function applyOperation(
  operation: ReleaseOperation,
  platform: ReleasePlatform
): Promise<void> {
  switch (operation.type) {
    case 'publish-npm':
      await platform.npm.publishPreparedPackage(
        operation.prepared,
        operation.npmTag
      );
      return;
    case 'create-git-tag':
      await platform.git.createTag(operation.tag, operation.sha);
      return;
    case 'create-github-release':
      await platform.github.createRelease(
        operation.tag,
        operation.sha,
        operation.notes
      );
      return;
    case 'upload-github-asset':
      await platform.github.uploadAsset(operation.releaseTag, operation.path);
      return;
    case 'copy-docker':
      await platform.docker.copyImage(operation.source, operation.target);
  }
}
