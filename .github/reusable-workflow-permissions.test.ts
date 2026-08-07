import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'yaml';

type JobConfig = {
  permissions?: Record<string, string>;
};

type WorkflowConfig = {
  jobs: Record<string, JobConfig | undefined>;
};

function readWorkflow(path: string): WorkflowConfig {
  return parse(readFileSync(path, 'utf8')) as WorkflowConfig;
}

function assertPermission(
  workflow: WorkflowConfig,
  jobName: string,
  permission: string,
  access: string
): void {
  const job = workflow.jobs[jobName];

  assert.ok(job, `Expected workflow to define ${jobName}`);
  assert.equal(
    job.permissions?.[permission],
    access,
    `Expected ${jobName} to grant ${permission}: ${access}`
  );
}

test('release callers grant permissions required by reusable E2E', () => {
  const release = readWorkflow('.github/workflows/release.yml');
  const prerelease = readWorkflow('.github/workflows/reusable-prerelease.yml');

  assertPermission(release, 'prerelease', 'pull-requests', 'read');
  assertPermission(prerelease, 'e2e', 'pull-requests', 'read');
  assertPermission(release, 'e2e', 'pull-requests', 'read');
});
