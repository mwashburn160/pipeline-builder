// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The lookup suites stub pipeline-core and slim with a local copy of
 * `toSynthPlugin` (helpers/synth-plugin.ts). This suite loads the real module,
 * so the copy can't drift from the fields `/plugins/lookup` actually omits.
 */

import { describe, it, expect } from '@jest/globals';
import { SYNTH_OMITTED_PLUGIN_FIELDS, toSynthPlugin } from '@pipeline-builder/pipeline-core';
import * as helper from './helpers/synth-plugin.js';

describe('the lookup suites\' toSynthPlugin copy', () => {
  it('omits exactly the fields pipeline-core omits', () => {
    expect([...helper.SYNTH_OMITTED_PLUGIN_FIELDS].sort()).toEqual([...SYNTH_OMITTED_PLUGIN_FIELDS].sort());
    const record = Object.fromEntries([...SYNTH_OMITTED_PLUGIN_FIELDS, 'name', 'commands'].map((k) => [k, k]));
    expect(helper.toSynthPlugin(record)).toEqual(toSynthPlugin(record));
  });
});
