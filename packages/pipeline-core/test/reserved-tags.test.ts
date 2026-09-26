// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A caller must never be able to set the tags that decide WHOSE reports an
 * execution belongs to.
 *
 * The events Lambda reads `pb.pipeline-id` and `pb.deploys` off the stack to
 * attribute executions, and `OrgId` drives cost attribution. `props.tags` used
 * to be applied AFTER the platform tags, and `Tags.of` lets a later add replace
 * an earlier one — so a caller could redefine them and point another org's
 * executions at their own pipeline.
 *
 * Two halves, both tested: the platform tags are applied LAST so they win, and
 * reserved keys are dropped outright (ordering alone would not stop a caller
 * setting `pb.deploys` on a pipeline that declares no environment, where there
 * is no platform tag to overwrite it).
 */

import { describe, it, expect } from '@jest/globals';
import { isReservedTagKey, RESERVED_TAG_KEYS } from '../src/config/app-config.js';

describe('isReservedTagKey', () => {
  it('refuses the tenancy and attribution keys', () => {
    for (const key of ['OrgId', 'pb.pipeline-id', 'pb.deploys', 'pipeline-builder', 'project', 'organization']) {
      expect([key, isReservedTagKey(key)]).toEqual([key, true]);
    }
  });

  it('refuses any pb.* key, not only the ones in use today', () => {
    // A new pb.* tag must be protected the day it is introduced, without
    // anyone remembering to extend a list.
    expect(isReservedTagKey('pb.something-added-later')).toBe(true);
  });

  it('refuses the aws: prefix AWS reserves for itself', () => {
    expect(isReservedTagKey('aws:cloudformation:stack-name')).toBe(true);
  });

  it('is case- and whitespace-insensitive, so casing is not a bypass', () => {
    for (const key of ['orgid', 'ORGID', 'PB.deploys', '  OrgId  ', 'Pb.Pipeline-Id']) {
      expect([key, isReservedTagKey(key)]).toEqual([key, true]);
    }
  });

  it('allows ordinary tags', () => {
    for (const key of ['team', 'cost-center', 'env', 'owner', 'pbx', 'projector']) {
      expect([key, isReservedTagKey(key)]).toEqual([key, false]);
    }
  });

  it('lists the exact keys the API refuses, so the two checks cannot drift', () => {
    expect([...RESERVED_TAG_KEYS].sort()).toEqual(['OrgId', 'organization', 'pipeline-builder', 'project']);
  });
});
