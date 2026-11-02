// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's pipeline-side vulnerability surface: `plugin verify`'s step
 * sources and verdict handling (report-only), `security-report upload`'s body,
 * and the structured `PB_SYNTH_FAILURE` line a failed CodeBuild synth prints.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

const { loadVerifySteps, runtimeCheck } = await import('../src/commands/verify-plugins.js');
const { buildSecurityReportBody } = await import('../src/commands/security-report.js');
const { emitSynthFailure } = await import('../src/commands/synth.js');
const { PluginResolutionError } = await import('../src/utils/plugin-resolver.js');

const DIGEST = `sha256:${'d'.repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), 'pm-vuln-'));
const file = (name: string, body: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

describe('plugin verify — step sources', () => {
  it('reads --steps-file', () => {
    expect(loadVerifySteps({ stepsFile: file('s.json', [{ stepKey: 'a', imageDigest: DIGEST }]) }, {}))
      .toEqual([{ stepKey: 'a', imageDigest: DIGEST }]);
  });

  it('reads the image-backed, keyed rows of a step manifest', () => {
    const manifest = file('m.json', [
      { stageName: 's', actionName: 'a', pluginId: 'x', pluginName: 'trivy', pluginVersion: '1', imageDigest: DIGEST, stepKey: 'trivy-alias' },
      { stageName: 's', actionName: 'b', pluginId: 'y', pluginName: 'meta', pluginVersion: '1', imageDigest: null, stepKey: 'meta-alias' },
    ]);
    expect(loadVerifySteps({ manifest }, {})).toEqual([{ stepKey: 'trivy-alias', imageDigest: DIGEST }]);
  });

  it('falls back to PB_VERIFY_STEPS, and refuses no source or an empty list', () => {
    expect(loadVerifySteps({}, { PB_VERIFY_STEPS: JSON.stringify([{ stepKey: 'a', imageDigest: DIGEST }]) })).toHaveLength(1);
    expect(() => loadVerifySteps({}, {})).toThrow(/No steps to verify/);
    expect(() => loadVerifySteps({}, { PB_VERIFY_STEPS: '[]' })).toThrow(/No image-backed steps/);
  });
});

describe('plugin verify — runtime-check call', () => {
  const client = (body: unknown) => ({
    post: jest.fn(async (_url: string, _body: unknown) => body),
    getConfig: () => ({ api: { pluginUrl: '/api/plugins' } }),
  });

  it('posts { pipelineId, steps } and unwraps the graded verdict', async () => {
    const c = client({ success: true, data: { verdict: 'critical', steps: [] } });
    const result = await runtimeCheck(c as never, 'pipe-1', [{ stepKey: 'a', imageDigest: DIGEST }]);
    expect(result.verdict).toBe('critical');
    expect(c.post).toHaveBeenCalledWith('/api/plugins/runtime-check', { pipelineId: 'pipe-1', steps: [{ stepKey: 'a', imageDigest: DIGEST }] });
  });

  it('refuses an unreadable answer (the caller then warns, or fails with --strict)', async () => {
    await expect(runtimeCheck(client({ data: { verdict: 'block' } }) as never, 'p', [])).rejects.toThrow(/no readable verdict/);
  });
});

describe('security-report upload body', () => {
  it('builds { tool, format, executionId, stage, report } from the file and env', () => {
    const body = buildSecurityReportBody(
      { file: file('r.sarif', { version: '2.1.0', runs: [] }), tool: 'trivy', format: 'sarif', stage: 'Build' },
      { PIPELINE_EXECUTION_ID: 'exec-9' },
    );
    expect(body).toEqual({ tool: 'trivy', format: 'sarif', executionId: 'exec-9', stage: 'Build', report: { version: '2.1.0', runs: [] } });
  });

  it('refuses an unknown format, a bad tool name and a non-JSON report', () => {
    const ok = file('ok.json', {});
    expect(() => buildSecurityReportBody({ file: ok, tool: 'trivy', format: 'xml' }, {})).toThrow(/--format/);
    expect(() => buildSecurityReportBody({ file: ok, tool: 'bad tool!', format: 'sarif' }, {})).toThrow(/--tool/);
    expect(() => buildSecurityReportBody({ file: file('bad.json', 'not json'), tool: 'trivy', format: 'trivy-json' }, {})).toThrow(/not valid JSON/);
  });
});

describe('PB_SYNTH_FAILURE line', () => {
  const saved = process.env.CODEBUILD_BUILD_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEBUILD_BUILD_ID; else process.env.CODEBUILD_BUILD_ID = saved;
    jest.restoreAllMocks();
  });

  it('prints one structured line inside CodeBuild, carrying each refusal', () => {
    process.env.CODEBUILD_BUILD_ID = 'proj:1';
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    emitSynthFailure(new PluginResolutionError([{ plugin: 'lint', code: 'PLUGIN_NOT_INSTALLED', message: 'not installed' }]));
    const line = String(err.mock.calls[0]![0]);
    expect(line.startsWith('PB_SYNTH_FAILURE {')).toBe(true);
    expect(JSON.parse(line.slice('PB_SYNTH_FAILURE '.length))).toEqual({
      code: 'PLUGIN_NOT_INSTALLED', message: 'not installed', plugins: [{ plugin: 'lint', code: 'PLUGIN_NOT_INSTALLED', message: 'not installed' }],
    });
  });

  it('codes any other failure SYNTH_FAILED, and prints nothing outside CodeBuild', () => {
    process.env.CODEBUILD_BUILD_ID = 'proj:1';
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    emitSynthFailure(new Error('cdk exploded'));
    expect(String(err.mock.calls[0]![0])).toContain('"code":"SYNTH_FAILED"');
    err.mockClear();
    delete process.env.CODEBUILD_BUILD_ID;
    emitSynthFailure(new Error('x'));
    expect(err).not.toHaveBeenCalled();
  });
});
