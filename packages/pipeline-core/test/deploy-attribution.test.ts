// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `describeDeployAttribution` is the DORA deploy derivation, split out of
 * `PipelineBuilder` so it runs WITHOUT `aws-cdk-lib` — the API returns these
 * warnings in the create and validate responses, and previously they reached a
 * synth log only, which nobody reads until the reports are already attributing
 * deploys to the wrong stage.
 *
 * The construct and the API must agree, so the derivation is pinned here and
 * `pipeline-builder.test.ts` proves the synthesized tag matches.
 */

import { describe, it, expect } from '@jest/globals';
import { codePipelineStageName, describeDeployAttribution, MAX_TAG_VALUE_LENGTH } from '../src/pipeline/deploy-attribution.js';

const input = (over: Record<string, unknown>) => over as Parameters<typeof describeDeployAttribution>[0];

describe('codePipelineStageName', () => {
  it('is the alias when one is declared', () => {
    expect(codePipelineStageName({ stageName: 'deploy', alias: 'Prod' })).toBe('Prod');
  });

  it('falls back to `<stageName>-alias`, which is what events report', () => {
    expect(codePipelineStageName({ stageName: 'deploy' })).toBe('deploy-alias');
  });
});

describe('describeDeployAttribution', () => {
  it('produces no deploy signal when nothing declares an environment', () => {
    const r = describeDeployAttribution(input({ stages: [{ stageName: 'test' }] }));
    expect([r.deploysTag, r.deploys, r.warnings]).toEqual([undefined, [], []]);
  });

  it('lists every stage that declares its own environment, with no warning', () => {
    const r = describeDeployAttribution(input({
      stages: [
        { stageName: 'stg', alias: 'Staging', environment: 'staging' },
        { stageName: 'prd', alias: 'Prod', environment: 'production' },
      ],
    }));
    expect(r.deploysTag).toBe('Staging:staging+Prod:production');
    expect(r.deploys.every((d) => !d.inferred)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('attributes a pipeline-level environment to a sole stage without warning', () => {
    const r = describeDeployAttribution(input({ stages: [{ stageName: 'only' }], environment: 'production' }));
    expect(r.deploysTag).toBe('only-alias:production');
    expect(r.deploys).toEqual([{ stage: 'only-alias', environment: 'production', inferred: false }]);
    expect(r.warnings).toEqual([]);
  });

  it('WARNS when a pipeline-level environment is guessed onto the last of many stages', () => {
    // This is the warning the API now returns: the deploy is attributed to a stage
    // the author never named, so every DORA number for it is a guess.
    const r = describeDeployAttribution(input({
      stages: [{ stageName: 'build' }, { stageName: 'test' }, { stageName: 'ship' }],
      environment: 'production',
    }));
    expect(r.deploys).toEqual([{ stage: 'ship-alias', environment: 'production', inferred: true }]);
    expect(r.warnings.map((w) => w.code)).toEqual(['inferred-stage']);
    expect(r.warnings[0].message).toContain('ship-alias');
  });

  it('uses a literal Deploy stage when there are no stages to name', () => {
    const r = describeDeployAttribution(input({ environment: 'production' }));
    expect(r.deploysTag).toBe('Deploy:production');
  });

  it('sanitizes characters AWS rejects in a tag value', () => {
    const r = describeDeployAttribution(input({ stages: [{ stageName: 'a b', environment: 'pre prod' }] }));
    // `:` and `+` are this format's delimiters, so nothing else may introduce one.
    expect(r.deploysTag).toBe('a-b-alias:pre-prod');
  });

  it('caps the tag at the AWS limit and warns, keeping production first', () => {
    const stages = Array.from({ length: 40 }, (_, i) => ({
      stageName: `stage-with-a-long-name-${i}`, environment: `environment-number-${i}`,
    }));
    stages.push({ stageName: 'final', environment: 'production' });
    const r = describeDeployAttribution(input({ stages }));

    expect(r.deploysTag!.length).toBeLessThanOrEqual(MAX_TAG_VALUE_LENGTH);
    // The production pair is never the one dropped — it is the most
    // operationally-significant deploy.
    expect(r.deploysTag!.startsWith('final-alias:production')).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['pairs-dropped']);
  });

  it('ignores an empty-string environment', () => {
    const r = describeDeployAttribution(input({ stages: [{ stageName: 'a', environment: '' }] }));
    expect(r.deploysTag).toBeUndefined();
  });
});
