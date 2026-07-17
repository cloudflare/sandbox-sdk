import { describe, expect, it } from 'bun:test';
import {
  isMissingJavaScriptExecutorError,
  summarizeSpawnOutput
} from './config';

describe('sidecar pool config helpers', () => {
  it('summarizes spawn output for bounded logs', () => {
    const summary = summarizeSpawnOutput(`line 1\n\n${'x'.repeat(300)}`);

    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(240);
  });

  it('classifies missing JavaScript executor startup errors', () => {
    expect(
      isMissingJavaScriptExecutorError(
        new Error('JavaScript executor binary not found. Checked: path')
      )
    ).toBe(true);
    expect(isMissingJavaScriptExecutorError(new Error('other'))).toBe(false);
  });
});
