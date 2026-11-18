// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/audit.ts — the moved controllers' `audit(req, …)` / `recordAuditEvent`
 * call sites now emit through api-core's REMOTE audit client (platform's
 * `POST /audit/events` ingest). Pins how the request's identity maps onto the
 * remote event: actor, the org it is recorded for, and `affectedOrgId` only
 * when it is a different org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const recordAudit = jest.fn();
const real = await import('@pipeline-builder/api-core');
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: (e: unknown) => recordAudit(e) }));

const { audit, recordAuditEvent } = await import('../src/helpers/audit.js');

beforeEach(() => { recordAudit.mockClear(); });

describe('audit(req, …)', () => {
  it('records for the caller\'s org, with the target and details', () => {
    const req = { user: { sub: 'u1', email: 'u@a.test', organizationId: 'org-a' } } as never;
    audit(req, 'dashboard.create', { targetType: 'dashboard', targetId: 'd1', details: { name: 'n' } });
    expect(recordAudit).toHaveBeenCalledWith({
      action: 'dashboard.create',
      actorId: 'u1',
      actorEmail: 'u@a.test',
      orgId: 'org-a',
      targetType: 'dashboard',
      targetId: 'd1',
      outcome: 'success',
      details: { name: 'n' },
    });
  });

  it('names a different affected org, drops a same-org one, and falls back to the system org / anonymous actor', () => {
    audit({ user: { sub: 'admin', organizationId: 'sys' } } as never, 'dashboard.update', { affectedOrgId: 'org-b', outcome: 'failure' });
    expect(recordAudit.mock.calls[0]![0]).toMatchObject({ orgId: 'sys', affectedOrgId: 'org-b', outcome: 'failure' });
    audit({ user: { sub: 'u', organizationId: 'org-a' } } as never, 'dashboard.update', { affectedOrgId: 'org-a' });
    expect(recordAudit.mock.calls[1]![0]).not.toHaveProperty('affectedOrgId');
    audit({} as never, 'dashboard.delete');
    expect(recordAudit.mock.calls[2]![0]).toMatchObject({ actorId: real.ANONYMOUS_ACTOR_ID, orgId: real.SYSTEM_ORG_ID });
    expect(recordAudit.mock.calls[2]![0]).not.toHaveProperty('actorEmail');
  });
});

describe('recordAuditEvent', () => {
  it('records a machine event for the system org by default', () => {
    recordAuditEvent({ action: 'observability.pvc.autoexpand', actorId: 'alertmanager:am-0', targetType: 'pvc', targetId: 'data-x', details: { to: '20Gi' } });
    expect(recordAudit).toHaveBeenCalledWith({
      action: 'observability.pvc.autoexpand',
      actorId: 'alertmanager:am-0',
      orgId: real.SYSTEM_ORG_ID,
      targetType: 'pvc',
      targetId: 'data-x',
      outcome: 'success',
      details: { to: '20Gi' },
    });
  });

  it('keeps an explicit org, email, outcome and a different affected org', () => {
    recordAuditEvent({ action: 'dashboard.purge', actorId: 'system', actorEmail: 'x@y.z', orgId: 'o1', affectedOrgId: 'o2', outcome: 'failure' });
    expect(recordAudit.mock.calls[0]![0]).toEqual({ action: 'dashboard.purge', actorId: 'system', actorEmail: 'x@y.z', orgId: 'o1', affectedOrgId: 'o2', outcome: 'failure' });
  });
});
