// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact keys for publisher-qualified references (W2 §3.5): the plugin-alias
 * segment matches pipeline-core's `pluginArtifactAlias`, and output directories
 * come from own plugins first, then catalog listings.
 */
import { describe, it, expect } from '@jest/globals';
import { computeAvailableArtifacts, pluginArtifactAlias } from '../src/lib/artifact-keys';
import { createEmptyStep, createInitialFormState, type FormStage } from '../src/types/form-types';
import type { Plugin } from '../src/types';
import { catalogEntry, installView, officialEntry } from './helpers/pluginInstallFixtures';

describe('pluginArtifactAlias', () => {
  it('explicit alias, else publisher-name-alias, else name-alias', () => {
    expect(pluginArtifactAlias({ alias: 'mine', publisher: 'acme', name: 'tf' })).toBe('mine');
    expect(pluginArtifactAlias({ publisher: 'acme', name: 'tf' })).toBe('acme-tf-alias');
    expect(pluginArtifactAlias({ publisher: '', name: 'tf' })).toBe('tf-alias');
    expect(pluginArtifactAlias({ name: 'tf' })).toBe('tf-alias');
  });
});

describe('computeAvailableArtifacts with listings', () => {
  const acme = catalogEntry({
    install: installView(),
    resolved: { ...officialEntry().resolved!, version: '1.2.0', primaryOutputDirectory: 'plan-out' },
  });
  const trivy = officialEntry('trivy');
  const ownTrivy = { id: 'p1', name: 'trivy', version: '1.0.0', isDefault: true, primaryOutputDirectory: 'own-out' } as Plugin;

  function state(steps: Array<{ publisher: string; name: string }>) {
    const s = createInitialFormState();
    s.synth.plugin = { ...s.synth.plugin, publisher: 'acme', name: 'terraform-plan' };
    const stage: FormStage = {
      id: 's', stageName: 'build', alias: '', environment: '',
      steps: steps.map((p) => ({ ...createEmptyStep(), plugin: { ...createEmptyStep().plugin, ...p } })),
    };
    return { synth: s.synth, stages: [stage] };
  }

  it('resolves a qualified synth plugin and a bare Official step from the catalog', () => {
    const { synth, stages } = state([{ publisher: '', name: 'trivy' }, { publisher: '', name: 'next' }]);
    const opts = computeAvailableArtifacts(synth, stages, { plugins: [], catalog: [acme, trivy] }, 0, 1);
    expect(opts.map((o) => o.key)).toEqual([
      'no-stage:no-stage-alias:terraform-plan:acme-terraform-plan-alias:plan-out',
      'build:build-alias:trivy:trivy-alias:reports',
    ]);
    expect(opts[0].label).toBe('acme/terraform-plan → plan-out');
  });

  it('an own plugin wins for an unqualified name; a qualified one only matches its publisher', () => {
    const { synth, stages } = state([{ publisher: '', name: 'trivy' }, { publisher: 'other', name: 'trivy' }, { publisher: '', name: 'x' }]);
    const opts = computeAvailableArtifacts(synth, stages, { plugins: [ownTrivy], catalog: [trivy] }, 0, 2);
    // Synth (acme) is not in this catalog → no synth artifact; step 2 (other/trivy) doesn't resolve.
    expect(opts.map((o) => o.key)).toEqual(['build:build-alias:trivy:trivy-alias:own-out']);
  });
});
