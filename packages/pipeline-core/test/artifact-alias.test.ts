// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pluginArtifactAlias` — the plugin-alias segment of an artifact key.
 *
 * Every key CONSUMER builds it as `alias || ${name}-alias`: the frontend's
 * artifact picker, the CLI pre-resolver, `PluginLookup.normalize`. The two key
 * PRODUCERS used to disagree in opposite directions — stage steps registered the
 * bare name and the synth step suffixed an explicit alias — so a step whose
 * input artifact was picked in the UI failed synth with "No artifact
 * registered". Both producers now call this; these cases pin the rule they share.
 */

import { describe, it, expect } from '@jest/globals';
import { pluginArtifactAlias, pluginStepIdAlias, sanitizePublisher } from '../src/core/plugin-contract.js';

describe('pluginArtifactAlias', () => {
  it('suffixes the name when there is no alias (the stage-step case that registered the bare name)', () => {
    expect(pluginArtifactAlias({ name: 'nodejs-build' })).toBe('nodejs-build-alias');
  });

  it('uses an explicit alias VERBATIM (the synth case that suffixed it)', () => {
    expect(pluginArtifactAlias({ name: 'cdk-synth', alias: 'my-synth' })).toBe('my-synth');
  });

  it('treats an empty alias as absent, as the frontend picker does', () => {
    // The picker uses `||`; a `??` here would register `…::cdk.out` for an
    // empty alias while the UI asked for `…:cdk-synth-alias:cdk.out`.
    expect(pluginArtifactAlias({ name: 'cdk-synth', alias: '' })).toBe('cdk-synth-alias');
  });
});

describe('publisher references (plugin ecosystem §3.5)', () => {
  it('puts the publisher in the key and the construct id of a qualified reference', () => {
    expect(pluginArtifactAlias({ name: 'lint', publisher: 'acme' })).toBe('acme-lint-alias');
    expect(pluginStepIdAlias({ name: 'lint', publisher: 'acme' })).toBe('acme-lint');
  });

  it('leaves an unqualified reference (and any explicit alias) exactly as it was', () => {
    expect(pluginStepIdAlias({ name: 'lint' })).toBe('lint');
    expect(pluginStepIdAlias({ name: 'lint', publisher: 'acme', alias: 'l' })).toBe('l');
    expect(pluginStepIdAlias({ name: 'lint', alias: '' })).toBe('');
    expect(pluginArtifactAlias({ name: 'lint', publisher: 'acme', alias: 'l' })).toBe('l');
  });

  it('sanitizes a publisher to construct-id characters', () => {
    expect(sanitizePublisher('acme.corp/x')).toBe('acme-corp-x');
    expect(sanitizePublisher('acme_1-x')).toBe('acme_1-x');
  });
});
