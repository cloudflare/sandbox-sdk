import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'yaml';

const pathFiltersSource = readFileSync('.github/path-filters.yml', 'utf8');
const pathFiltersConfig = parse(pathFiltersSource) as Record<string, string[]>;
const prWorkflowSource = readFileSync('.github/workflows/pr.yml', 'utf8');
const prWorkflowConfig = parseWorkflow(prWorkflowSource);
const qualityWorkflowSource = readFileSync(
  '.github/workflows/reusable-quality.yml',
  'utf8'
);
const turboConfig = JSON.parse(readFileSync('turbo.json', 'utf8')) as {
  tasks: { test: { inputs: string[] } };
};

type WorkflowConfig = {
  jobs: Record<string, JobConfig | undefined>;
};

type JobConfig = {
  if?: unknown;
  name?: unknown;
  needs?: unknown;
  steps?: StepConfig[];
  'timeout-minutes'?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

type StepConfig = {
  name?: string;
  run?: unknown;
  if?: unknown;
};

function parseWorkflow(source: string): WorkflowConfig {
  return parse(source) as WorkflowConfig;
}

function job(workflow: WorkflowConfig, jobName: string): JobConfig {
  const config = workflow.jobs[jobName];

  assert.ok(config, `Expected workflow to define ${jobName}`);

  return config;
}

function jobSteps(workflow: WorkflowConfig, jobName: string): StepConfig[] {
  const steps = job(workflow, jobName).steps;

  assert.ok(Array.isArray(steps), `Expected ${jobName} to define steps`);

  return steps;
}

function runStepInvokes(step: StepConfig, command: string): boolean {
  if (typeof step.run !== 'string' || step.if !== undefined) {
    return false;
  }

  return step.run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .some((line) => line === command || line.startsWith(`${command} `));
}

function assertActiveJobRun(
  workflowSource: string,
  jobName: string,
  command: string
): void {
  const workflow = parseWorkflow(workflowSource);
  const steps = jobSteps(workflow, jobName);

  assert.ok(
    steps.some((step) => runStepInvokes(step, command)),
    `Expected ${jobName} to unconditionally invoke ${command}`
  );
}

function assertFilterIncludes(filterName: string, pattern: string): void {
  assert.ok(
    pathFiltersConfig[filterName]?.includes(pattern),
    `Expected ${filterName} path filter to include ${pattern}`
  );
}

function deriveConditionsScript(workflow = prWorkflowConfig): string {
  const deriveStep = jobSteps(workflow, 'detect-changes').find(
    (step) => step.name === 'Derive conditions'
  );

  assert.equal(typeof deriveStep?.run, 'string');

  return deriveStep.run;
}

function derivedConditionFilters(
  outputName: string,
  workflow = prWorkflowConfig
): string[] {
  const lines = deriveConditionsScript(workflow).split('\n');
  const trueOutput = `echo "${outputName}=true" >> "$GITHUB_OUTPUT"`;
  const falseOutput = `echo "${outputName}=false" >> "$GITHUB_OUTPUT"`;
  const trueIndexes = lines.flatMap((line, index) =>
    line.trim() === trueOutput ? [index] : []
  );
  const falseIndexes = lines.flatMap((line, index) =>
    line.trim() === falseOutput ? [index] : []
  );

  assert.deepEqual(trueIndexes.length, 1, `Expected one active ${trueOutput}`);
  assert.deepEqual(
    falseIndexes.length,
    1,
    `Expected one active ${falseOutput}`
  );

  const trueIndex = trueIndexes[0];
  const ifIndex = lines.findLastIndex(
    (line, index) => index < trueIndex && line.trim().startsWith('if [[')
  );
  assert.ok(ifIndex >= 0, `Expected an if block producing ${outputName}`);

  const conditionEndIndex = lines.findIndex(
    (line, index) => index >= ifIndex && line.trim().endsWith(']]; then')
  );
  assert.ok(
    conditionEndIndex >= ifIndex && conditionEndIndex < trueIndex,
    `Expected ${outputName} output immediately after its condition`
  );
  assert.ok(
    lines.slice(conditionEndIndex + 1, trueIndex).every((line) => !line.trim()),
    `Expected no commands before ${trueOutput}`
  );
  assert.equal(
    lines
      .slice(trueIndex + 1, falseIndexes[0])
      .filter((line) => line.trim() === 'else').length,
    1,
    `Expected ${outputName} false output in the matching else block`
  );

  const condition = lines
    .slice(ifIndex, conditionEndIndex + 1)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const filterExpression =
    /"\$\{\{\s*steps\.filter\.outputs\.([\w-]+)\s*\}\}"\s*==\s*"true"/g;
  const filters = [...condition.matchAll(filterExpression)].map(
    (match) => match[1]
  );
  const residue = condition
    .replace(filterExpression, '')
    .replace(/if\s*\[\[/, '')
    .replace(/\]\];\s*then/, '')
    .replaceAll('||', '')
    .replaceAll('\\', '')
    .trim();

  assert.equal(
    residue,
    '',
    `Expected ${outputName} condition to contain only active filter expressions`
  );

  return filters;
}

function assertDerivedCondition(
  outputName: string,
  expectedFilters: string[],
  workflow = prWorkflowConfig
): void {
  assert.deepEqual(
    derivedConditionFilters(outputName, workflow),
    expectedFilters,
    `Expected exact filters for ${outputName}`
  );
}

function jobNeeds(config: JobConfig): string[] {
  if (typeof config.needs === 'string') {
    return [config.needs];
  }

  assert.ok(
    Array.isArray(config.needs),
    'Expected job needs to be a string or array'
  );
  return config.needs as string[];
}

function assertPRContainerForwarding(workflowSource: string): void {
  assert.equal(
    job(parseWorkflow(workflowSource), 'quality').with?.run_container_tests,
    "${{ needs.detect-changes.outputs.needs-container-tests == 'true' }}"
  );
}

function assertContainerTestJob(workflowSource: string): void {
  const workflow = parseWorkflow(workflowSource);

  const containerTests = job(workflow, 'container-tests');

  assert.equal(containerTests.if, '${{ inputs.run_container_tests }}');
  assert.equal(containerTests['timeout-minutes'], 10);
  assertActiveJobRun(
    workflowSource,
    'container-tests',
    'npm test -w @repo/sandbox-container'
  );
  assertActiveJobRun(
    workflowSource,
    'container-tests',
    'npm test -w @repo/sandbox-execution'
  );
}

test('sandbox-execution changes request container-backed tests', () => {
  assertFilterIncludes('container', 'packages/sandbox-execution/**');
  assertFilterIncludes('any-source', 'packages/**');
  assertDerivedCondition('needs-container-tests', [
    'shared',
    'container',
    'build-config',
    'deps'
  ]);
});

test('source and configuration changes request quality checks', () => {
  assertDerivedCondition('needs-quality', [
    'any-source',
    'build-config',
    'ci-config',
    'deps',
    'changesets'
  ]);
});

test('quality guard and workflow changes request quality checks', () => {
  assertFilterIncludes('ci-config', '.github/quality-config.test.ts');
  assertFilterIncludes('ci-config', '.github/workflows/reusable-quality.yml');
  assertFilterIncludes('ci-config', '.github/workflows/pr.yml');
  assertFilterIncludes('ci-config', '.github/path-filters.yml');
  assertFilterIncludes('ci-config', '.github/test-release-tools.sh');
});

test('derived output assertions reject comments and wrong output blocks', () => {
  const commentedWorkflow = parseWorkflow(
    prWorkflowSource.replace(
      '             || "${{ steps.filter.outputs.ci-config }}" == "true" \\\n',
      '             # "${{ steps.filter.outputs.ci-config }}" == "true" \\\n'
    )
  );
  assert.throws(() =>
    assertDerivedCondition(
      'needs-quality',
      ['any-source', 'build-config', 'ci-config', 'deps', 'changesets'],
      commentedWorkflow
    )
  );

  const wrongBlockWorkflow = parseWorkflow(
    prWorkflowSource
      .replace(
        '             || "${{ steps.filter.outputs.container }}" == "true" \\\n',
        '             || "${{ steps.filter.outputs.sdk }}" == "true" \\\n'
      )
      .replace(
        '             || "${{ steps.filter.outputs.ci-config }}" == "true" \\\n',
        '             || "${{ steps.filter.outputs.container }}" == "true" \\\n'
      )
  );
  assert.throws(() =>
    assertDerivedCondition(
      'needs-container-tests',
      ['shared', 'container', 'build-config', 'deps'],
      wrongBlockWorkflow
    )
  );
});

test('PR quality caller forwards the container test condition', () => {
  assertPRContainerForwarding(prWorkflowSource);
  assert.throws(() =>
    assertPRContainerForwarding(
      prWorkflowSource.replace(
        "run_container_tests: ${{ needs.detect-changes.outputs.needs-container-tests == 'true' }}",
        'run_container_tests: false'
      )
    )
  );
});

test('PR has an independent unconditional configuration guard', () => {
  const configGuard = job(prWorkflowConfig, 'config-guard');

  assert.equal(configGuard.name, 'ci/config');
  assert.equal(configGuard.if, undefined);
  assert.equal(configGuard.needs, undefined);
  assert.equal(configGuard.uses, undefined);
  assertActiveJobRun(
    prWorkflowSource,
    'config-guard',
    'npm run test:release-tools'
  );

  const basicGate = job(prWorkflowConfig, 'basic-gate');
  assert.equal(basicGate.name, 'ci/basic');
  assert.ok(jobNeeds(basicGate).includes('config-guard'));
  assert.ok(
    jobSteps(prWorkflowConfig, 'basic-gate').some(
      (step) =>
        typeof step.run === 'string' &&
        step.run
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => !line.startsWith('#'))
          .includes(
            'if [[ "${{ needs.config-guard.result }}" != "success" ]]; then'
          )
    ),
    'Expected ci/basic to require successful configuration validation'
  );
});

test('quality workflow runs release/config tests from the PR quality job', () => {
  assertActiveJobRun(
    qualityWorkflowSource,
    'lint-typecheck',
    'npm run test:release-tools'
  );
});

test('quality workflow requires active container and execution package tests', () => {
  assertContainerTestJob(qualityWorkflowSource);
});

test('quality workflow container test assertions reject inactive matches', () => {
  const command = 'npm test -w @repo/sandbox-execution';

  for (const replacement of [
    '# run: npm test -w @repo/sandbox-execution',
    'if: false\n        run: npm test -w @repo/sandbox-execution',
    'if: ${{ 1 == 0 }}\n        run: npm test -w @repo/sandbox-execution',
    'run: echo npm test -w @repo/sandbox-execution'
  ]) {
    assert.throws(() =>
      assertActiveJobRun(
        qualityWorkflowSource.replace(
          'run: npm test -w @repo/sandbox-execution',
          replacement
        ),
        'container-tests',
        command
      )
    );
  }

  assert.throws(() =>
    assertActiveJobRun(
      qualityWorkflowSource
        .replace(
          'run: npm test -w @repo/sandbox-execution',
          'run: npm test -w @repo/sandbox'
        )
        .replace(
          '\n  container-tests:\n',
          '\n      - name: Wrong-job execution lifecycle tests\n        run: npm test -w @repo/sandbox-execution\n\n  container-tests:\n'
        ),
      'container-tests',
      command
    )
  );

  assert.throws(() =>
    assertContainerTestJob(
      qualityWorkflowSource.replace(
        '    if: ${{ inputs.run_container_tests }}',
        '    if: false'
      )
    )
  );
});

test('sandbox-execution test harness files are package-relative Turbo inputs', () => {
  const testInputs = turboConfig.tasks.test.inputs;

  assert.ok(testInputs.includes('Dockerfile.test'));
  assert.ok(testInputs.includes('scripts/**'));
  assert.ok(!testInputs.includes('packages/sandbox-execution/Dockerfile.test'));
  assert.ok(!testInputs.includes('packages/sandbox-execution/scripts/**'));
});
