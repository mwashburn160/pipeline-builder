// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stage/plugin/IAM projection the create + validate responses return, so a
 * reviewer approves something concrete instead of raw `props` JSON.
 *
 * Two properties matter most here and are pinned directly:
 *  - an UNPINNED plugin reports `latest`, never an empty version — an unpinned
 *    step resolves to whatever is newest at synth, which is the single most
 *    review-worthy fact about it;
 *  - a caller-supplied IAM role is flagged, because the pipeline then holds
 *    whatever that role already holds.
 */

import { describe, it, expect } from '@jest/globals';
import { diffStructure, previewStructure } from '../src/pipeline/structure-preview.js';

const build = (over: Record<string, unknown> = {}) => previewStructure({
  stages: [
    {
      stageName: 'test',
      steps: [{ plugin: { name: 'jest', publisher: 'acme', filter: { version: '1.2.3' } } }],
    },
    {
      stageName: 'ship',
      alias: 'Deploy',
      environment: 'production',
      steps: [{ plugin: { name: 'cdk-deploy' } }],
    },
  ],
  ...over,
} as Parameters<typeof previewStructure>[0]);

describe('previewStructure', () => {
  it('reports stages in declaration order with their CodePipeline names', () => {
    const preview = build();
    expect(preview.stages.map((s) => [s.stageName, s.codePipelineStage])).toEqual([
      // No alias ⇒ `<stageName>-alias`, which is what CodePipeline events report.
      ['test', 'test-alias'],
      ['ship', 'Deploy'],
    ]);
  });

  it('marks an unpinned plugin as `latest` rather than leaving it blank', () => {
    const preview = build();
    expect(preview.plugins).toEqual(['acme/jest@1.2.3', 'cdk-deploy@latest']);
  });

  it('scopes a plugin by publisher when one is declared', () => {
    expect(build().stages[0].steps[0].plugin).toBe('acme/jest');
  });

  it('reports the deploys the config will produce', () => {
    expect(build().deploys).toEqual([{ stage: 'Deploy', environment: 'production', inferred: false }]);
  });

  it('treats an absent role as platform-managed', () => {
    expect(build().iam).toEqual({ roleType: 'default', callerSupplied: false });
  });

  it('flags a caller-supplied role and names it', () => {
    const preview = build({ role: { type: 'roleArn', options: { roleArn: 'arn:aws:iam::x:role/Deploy' } } });
    expect(preview.iam).toEqual({
      roleType: 'roleArn', callerSupplied: true, roleRef: 'arn:aws:iam::x:role/Deploy',
    });
  });

  it('flags an OIDC role as caller-supplied too', () => {
    expect(previewStructure({ role: { type: 'oidcRole', options: {} } } as Parameters<typeof previewStructure>[0]).iam.callerSupplied).toBe(true);
  });

  it('handles a config with no stages at all', () => {
    const preview = previewStructure({} as Parameters<typeof previewStructure>[0]);
    expect([preview.stages, preview.plugins, preview.deploys]).toEqual([[], [], []]);
  });

  it('defaults a step position to pre', () => {
    expect(build().stages[0].steps[0].position).toBe('pre');
  });
});

describe('diffStructure', () => {
  it('reports no change for identical configurations', () => {
    expect(diffStructure(build(), build()).unchanged).toBe(true);
  });

  it('reports an added stage and its plugin', () => {
    const after = previewStructure({
      stages: [
        { stageName: 'test', steps: [{ plugin: { name: 'jest', publisher: 'acme', filter: { version: '1.2.3' } } }] },
        { stageName: 'ship', alias: 'Deploy', environment: 'production', steps: [{ plugin: { name: 'cdk-deploy' } }] },
        { stageName: 'scan', steps: [{ plugin: { name: 'trivy', filter: { version: '2.0.0' } } }] },
      ],
    } as Parameters<typeof previewStructure>[0]);
    const diff = diffStructure(build(), after);
    expect(diff.stagesAdded).toEqual(['scan']);
    expect(diff.pluginsAdded).toEqual(['trivy@2.0.0']);
    expect(diff.unchanged).toBe(false);
  });

  it('reports a version bump as a changed stage, not an added one', () => {
    const after = previewStructure({
      stages: [
        { stageName: 'test', steps: [{ plugin: { name: 'jest', publisher: 'acme', filter: { version: '2.0.0' } } }] },
        { stageName: 'ship', alias: 'Deploy', environment: 'production', steps: [{ plugin: { name: 'cdk-deploy' } }] },
      ],
    } as Parameters<typeof previewStructure>[0]);
    const diff = diffStructure(build(), after);
    expect(diff.stagesChanged).toEqual(['test']);
    expect(diff.stagesAdded).toEqual([]);
    expect(diff.pluginsAdded).toEqual(['acme/jest@2.0.0']);
    expect(diff.pluginsRemoved).toEqual(['acme/jest@1.2.3']);
  });

  it('reports an environment change as a changed stage', () => {
    const after = previewStructure({
      stages: [
        { stageName: 'test', steps: [{ plugin: { name: 'jest', publisher: 'acme', filter: { version: '1.2.3' } } }] },
        { stageName: 'ship', alias: 'Deploy', environment: 'staging', steps: [{ plugin: { name: 'cdk-deploy' } }] },
      ],
    } as Parameters<typeof previewStructure>[0]);
    expect(diffStructure(build(), after).stagesChanged).toEqual(['ship']);
  });

  it('surfaces an IAM role change, the change most worth review', () => {
    const before = build();
    const after = build({ role: { type: 'roleArn', options: { roleArn: 'arn:aws:iam::x:role/Admin' } } });
    const diff = diffStructure(before, after);
    expect(diff.iamChanged).toEqual({
      from: { roleType: 'default', callerSupplied: false },
      to: { roleType: 'roleArn', callerSupplied: true, roleRef: 'arn:aws:iam::x:role/Admin' },
    });
  });

  it('reads a renamed stage as one removed and one added', () => {
    // CodePipeline replaces the stage either way, so this is the honest summary.
    const after = previewStructure({
      stages: [
        { stageName: 'verify', steps: [{ plugin: { name: 'jest', publisher: 'acme', filter: { version: '1.2.3' } } }] },
        { stageName: 'ship', alias: 'Deploy', environment: 'production', steps: [{ plugin: { name: 'cdk-deploy' } }] },
      ],
    } as Parameters<typeof previewStructure>[0]);
    const diff = diffStructure(build(), after);
    expect([diff.stagesAdded, diff.stagesRemoved]).toEqual([['verify'], ['test']]);
    // The plugin set is unchanged — only the stage it sits in was renamed.
    expect([diff.pluginsAdded, diff.pluginsRemoved]).toEqual([[], []]);
  });
});
