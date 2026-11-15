// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The lookup suites stub pipeline-core and slim with a local copy of
 * `toResolvedPlugin` (helpers/resolved-plugin.ts). This suite loads the real module,
 * so the copy can't drift from the fields `/plugins/lookup` actually omits.
 */

import { describe, it, expect } from '@jest/globals';
import { RESOLVED_PLUGIN_OMITTED_FIELDS, toResolvedPlugin } from '@pipeline-builder/pipeline-core';
import * as helper from './helpers/resolved-plugin.js';

describe('the lookup suites\' toResolvedPlugin copy', () => {
  it('omits exactly the fields pipeline-core omits', () => {
    expect([...helper.RESOLVED_PLUGIN_OMITTED_FIELDS].sort()).toEqual([...RESOLVED_PLUGIN_OMITTED_FIELDS].sort());
    const record = Object.fromEntries([...RESOLVED_PLUGIN_OMITTED_FIELDS, 'name', 'commands'].map((k) => [k, k]));
    expect(helper.toResolvedPlugin(record)).toEqual(toResolvedPlugin(record));
  });
});
