// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: the quota service counts draft outcomes over the SAME catalog
 * ask-agent validates them with — the one copy in api-core — not a mirror.
 */

import { describe, it, expect } from '@jest/globals';
import * as core from '@pipeline-builder/api-core';
import { AI_DRAFT_FEATURES, AI_DRAFT_OUTCOMES, AI_DRAFT_OUTCOME_TALLY_FIELDS } from '../src/services/ai-draft-catalog.js';
import { DraftOutcomeSchema } from '../src/validation/schemas.js';

describe('AI draft catalog drift', () => {
  it('re-exports api-core\'s catalogs (same arrays, not copies)', () => {
    expect(AI_DRAFT_FEATURES).toBe(core.AI_DRAFT_FEATURES);
    expect(AI_DRAFT_OUTCOMES).toBe(core.AI_DRAFT_OUTCOMES);
  });

  it('the forwarded-count schema accepts exactly the shared catalogs', () => {
    const shape = DraftOutcomeSchema.shape.draftOutcome.shape;
    expect(shape.feature.options).toEqual([...core.AI_DRAFT_FEATURES]);
    expect(shape.outcome.options).toEqual([...core.AI_DRAFT_OUTCOMES]);
  });

  it('every shared outcome has a report tally field', () => {
    expect(Object.keys(AI_DRAFT_OUTCOME_TALLY_FIELDS).sort()).toEqual([...core.AI_DRAFT_OUTCOMES].sort());
  });
});
