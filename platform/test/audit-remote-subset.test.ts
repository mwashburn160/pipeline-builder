// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { REMOTE_AUDIT_ACTIONS, isRemoteAuditAction } from '@pipeline-builder/api-core';
import { mockConfig } from './helpers/config-mock.js';
// REAL api-core (not the shared mock) — this compares the package's actual
// remote allow-list against platform's own list.

// The AuditEvent model transitively imports the real `config` (which requires
// prod secrets under jest's NODE_ENV=test). We only need the static
// ALL_AUDIT_ACTIONS array + a Schema.index no-op, so stub config's single use.
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ audit: { retentionDays: 90 } }));

const { ALL_AUDIT_ACTIONS } = await import('../src/models/audit-event.js');
const { PLATFORM_AUDIT_ACTIONS } = await import('../src/constants/audit-actions.js');

/**
 * The full action set is platform's own list plus api-core's remote list. The
 * two must stay DISJOINT: an action in both would be accepted by the
 * `POST /audit/events` ingest, letting any service forge a platform-authority
 * event.
 */
describe('platform-only audit actions are not remote-emittable', () => {
  it('no PLATFORM_AUDIT_ACTIONS member is in REMOTE_AUDIT_ACTIONS', () => {
    const remote = new Set<string>(REMOTE_AUDIT_ACTIONS as readonly string[]);
    expect((PLATFORM_AUDIT_ACTIONS as readonly string[]).filter((a) => remote.has(a))).toEqual([]);
    expect(isRemoteAuditAction('admin.superadmin.grant')).toBe(false);
  });

  it('the combined list is exactly the two, with no duplicates', () => {
    expect(ALL_AUDIT_ACTIONS.length).toBe(PLATFORM_AUDIT_ACTIONS.length + REMOTE_AUDIT_ACTIONS.length);
    expect(new Set(ALL_AUDIT_ACTIONS).size).toBe(ALL_AUDIT_ACTIONS.length);
  });
});
