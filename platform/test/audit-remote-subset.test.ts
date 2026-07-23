// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
// REAL api-core (not the shared mock) — this test's whole point is to compare the
// package's actual remote allow-list against platform's actual action union.
import { REMOTE_AUDIT_ACTIONS, isRemoteAuditAction } from '@pipeline-builder/api-core';

// The AuditEvent model transitively imports the real `config` (which requires
// prod secrets under jest's NODE_ENV=test). We only need the static
// ALL_AUDIT_ACTIONS array + a Schema.index no-op, so stub config's single use.
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { audit: { retentionDays: 90 } },
}));

const { ALL_AUDIT_ACTIONS } = await import('../src/models/audit-event.js');

/**
 * DRIFT GUARD. Platform's `POST /audit/events` ingest validates incoming actions
 * against api-core's `REMOTE_AUDIT_ACTIONS` (the remote subset) rather than the
 * full platform union. If a member of that subset were NOT also a member of
 * platform's `ALL_AUDIT_ACTIONS`, a legitimate remote emit would be silently
 * 400-dropped at ingest. This test fails CI on such a divergence instead.
 */
describe('remote audit-action subset ⊆ platform audit-action union', () => {
  it('every REMOTE_AUDIT_ACTIONS member exists in platform ALL_AUDIT_ACTIONS', () => {
    const platformActions = new Set<string>(ALL_AUDIT_ACTIONS as readonly string[]);
    const missing = (REMOTE_AUDIT_ACTIONS as readonly string[]).filter((a) => !platformActions.has(a));
    expect(missing).toEqual([]);
  });

  it('isRemoteAuditAction accepts a remote action and rejects a platform-only one', () => {
    expect(isRemoteAuditAction('pipeline.create')).toBe(true);
    // A platform-authority action that must never be forgeable via the ingest.
    expect(isRemoteAuditAction('admin.superadmin.grant')).toBe(false);
  });
});
