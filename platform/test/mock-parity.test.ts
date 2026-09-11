// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
// REAL api-core (NOT the shared mock) — this test's whole point is to compare the
// hand-maintained mock's mirrored constants against api-core's actual values so a
// drift (a new permission/feature/tier/role/audit-action added to the real source
// but not the mock) fails CI here instead of surfacing as a confusing
// "does not provide an export named X" link failure in some unrelated suite.
// The api-core barrel loads config lazily, so importing these pure constants is
// side-effect-free under NODE_ENV=test (same as audit-remote-subset.test.ts).
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  TIER_FEATURES,
  ALL_FEATURE_FLAGS,
  VALID_TIERS,
  REMOTE_AUDIT_ACTIONS,
  resolveUserPermissions,
  scrubAwsIdentifiers,
} from '@pipeline-builder/api-core';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mock = apiCoreMock() as Record<string, unknown>;
const sorted = (a: readonly unknown[]): string[] => [...a].map(String).sort();

describe('mock-api-core parity with real api-core', () => {
  it('ALL_PERMISSIONS matches the real set', () => {
    expect(sorted(mock.ALL_PERMISSIONS as string[])).toEqual(sorted(ALL_PERMISSIONS));
  });

  it('ALL_FEATURE_FLAGS matches the real set', () => {
    expect(sorted(mock.ALL_FEATURE_FLAGS as string[])).toEqual(sorted(ALL_FEATURE_FLAGS));
  });

  it('VALID_TIERS matches the real set', () => {
    expect(sorted(mock.VALID_TIERS as string[])).toEqual(sorted(VALID_TIERS));
  });

  it('TIER_FEATURES matches the real map per tier', () => {
    const m = mock.TIER_FEATURES as Record<string, readonly string[]>;
    for (const tier of VALID_TIERS) {
      expect(sorted(m[tier] ?? [])).toEqual(sorted(TIER_FEATURES[tier]));
    }
  });

  it('ROLE_PERMISSIONS matches the real map per role', () => {
    const m = mock.ROLE_PERMISSIONS as Record<string, readonly string[]>;
    for (const role of ['member', 'admin', 'owner'] as const) {
      expect(sorted(m[role] ?? [])).toEqual(sorted(ROLE_PERMISSIONS[role]));
    }
  });

  it('REMOTE_AUDIT_ACTIONS matches the real set', () => {
    expect(sorted(mock.REMOTE_AUDIT_ACTIONS as string[])).toEqual(sorted(REMOTE_AUDIT_ACTIONS));
  });

  it('resolveUserPermissions produces the same result on representative inputs', () => {
    const resolve = mock.resolveUserPermissions as (p: readonly string[] | null, sa?: boolean) => string[];
    const cases: Array<{ perms: string[]; sa: boolean }> = [
      { perms: ['pipeline:read', 'plugins:write'], sa: false },
      { perms: [], sa: true }, // superadmin ⇒ every permission
      { perms: ['bogus:perm', 'pipeline:read'], sa: false }, // unknown filtered out
    ];
    for (const c of cases) {
      expect(sorted(resolve(c.perms, c.sa))).toEqual(
        sorted(resolveUserPermissions(c.perms as never, c.sa)),
      );
    }
  });

  it('scrubAwsIdentifiers redacts identically on a representative payload', () => {
    const scrub = mock.scrubAwsIdentifiers as <T>(v: T) => T;
    const sample = {
      accountId: '123456789012',
      arn: 'arn:aws:iam::123456789012:role/deploy',
      nested: { note: 'account 123456789012 in text', list: ['arn:aws:s3:::123456789012-bucket'] },
    };
    expect(scrub(sample)).toEqual(scrubAwsIdentifiers(sample));
  });
});
