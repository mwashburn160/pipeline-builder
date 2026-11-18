// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints platform SERVES (api-core
 * `PLATFORM_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  PLATFORM_INTERNAL,
  buildRouteTable,
  internalContractsServedBy,
  notifyEmailLegOf,
  type RouteTableEntry,
} from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';
import express, { type NextFunction, type Request, type Response } from 'express';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const ORG = '0123456789abcdef01234567';

const SAMPLES: Record<keyof typeof PLATFORM_INTERNAL, ContractSample> = {
  notifyEmail: {
    body: { orgId: ORG, subject: 'Subject', text: 'Body', targetUsers: ['u1'] },
    response: { ok: true, recipientCount: 1 },
  },
  notifyEmailStatus: { response: { enabled: true } },
  publisherEligibility: {
    params: { orgId: ORG },
    response: { verifiedDomains: ['example.com'], owners: 2, ownersWithMfa: 1 },
  },
  ecosystemApprovers: {
    query: { permission: 'plugins:moderate', excludeOrgIds: ORG, excludeUserIds: 'u1,u2' },
    response: { holders: 3, eligible: 2, superadmins: 1 },
  },
  offerSeatActivity: {
    params: { orgId: ORG },
    query: { windowDays: 30 },
    response: { seatActivity: { orgId: ORG, windowDays: 30, seatsHeld: 5, activeMembers: 3 } },
  },
  reportAuthority: {
    params: { orgId: ORG, userId: 'user_1' },
    response: { active: true, permissions: ['reports:read'], features: ['stakeholder_reports'], tier: 'pro' },
  },
  reportRecipientCheck: {
    params: { orgId: ORG },
    query: { email: 'lead@example.com' },
    response: { member: true, userId: 'user_1', displayName: 'Lead' },
  },
  reportAccessPosture: {
    params: { orgId: ORG },
    query: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
    response: { members: 18, membersWithMfa: 14, ssoRequired: false, serviceAccounts: 2, activeApiKeys: 4, permissionChanges: 3 },
  },
  supportEntitlement: {
    params: { orgId: ORG },
    response: {
      level: 'support_standard', premium: false, premiumLimit: 0, limit: 2, used: 1, ownOrgContacts: 1, canDesignate: true, canOpenCase: true,
    },
  },
  orgAIAccess: {
    params: { orgId: ORG },
    response: { aiEnabled: true, providers: ['anthropic'] },
  },
  orgAIKey: {
    params: { orgId: ORG, provider: 'anthropic' },
    response: { provider: 'anthropic', apiKey: 'sk-test' },
  },
  orgAccountRoot: {
    params: { orgId: ORG },
    response: { orgId: ORG, rootOrgId: '0123456789abcdef01234568' },
  },
  auditActivity: {
    body: { query: 'events_by_action', scope: { isSuperAdmin: false, orgId: ORG }, range: '1h', end: 1_800_000_000, limit: 50, vars: {} },
    response: { kind: 'matrix', series: [{ labels: { event: 'user.login' }, values: [{ time: 1_800_000_000, value: '2' }] }], step: '300s' },
  },
  liveOrgIds: {
    query: { limit: 10 },
    response: { orgIds: [ORG] },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const { mountApiRoutes } = await import('../src/routes/mount.js');
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  const app = express();
  mountApiRoutes(app, { scim: passthrough });
  table = buildRouteTable(app);
});

describe('platform internal endpoint contracts', () => {
  it('has a sample for every contract platform serves', () => {
    expect(internalContractsServedBy('platform').map((c) => c.id).sort())
      .toEqual(Object.values(PLATFORM_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(PLATFORM_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    const sample = SAMPLES[name as keyof typeof PLATFORM_INTERNAL];
    expect(() => roundTripContractSample(contract, sample)).not.toThrow();
  });

  describe('notify-email body legs', () => {
    const body = PLATFORM_INTERNAL.notifyEmail.body!;

    it('dispatches by key exactly as the relay does', () => {
      expect(notifyEmailLegOf({ reportRecipients: [], quotaNotice: true })).toBe('report');
      expect(notifyEmailLegOf({ quotaNotice: true, offerNotice: true })).toBe('quota');
      expect(notifyEmailLegOf({ offerNotice: true })).toBe('offer');
      expect(notifyEmailLegOf({ recipients: [] })).toBe('ecosystem');
      expect(notifyEmailLegOf({ orgId: ORG })).toBe('tenant');
      expect(notifyEmailLegOf(undefined)).toBe('tenant');
    });

    it('keeps each leg\'s discriminator (a quota notice is not stripped to a tenant email)', () => {
      expect(body.parse({ quotaNotice: true, orgId: ORG, subject: 's', text: 't' })).toEqual({ quotaNotice: true, orgId: ORG, subject: 's', text: 't' });
      expect(body.parse({ offerNotice: true, orgId: ORG, subject: 's', text: 't' })).toEqual({ offerNotice: true, orgId: ORG, subject: 's', text: 't' });
      expect(body.parse({ orgId: ORG, subject: 's', text: 't', reportRecipients: [{ email: 'a@b.c' }] }))
        .toEqual({ orgId: ORG, subject: 's', text: 't', reportRecipients: [{ email: 'a@b.c' }] });
    });

    it('validates an ecosystem notice with the relay\'s parser', () => {
      expect(body.parse({ event: 'N23', subject: 'S', text: 'T', recipients: [{ kind: 'superadmins' }] }))
        .toMatchObject({ event: 'N23', recipients: [{ kind: 'superadmins' }] });
      expect(body.safeParse({ event: 'nope', subject: 'S', text: 'T', recipients: [] }).success).toBe(false);
    });

    it('reports a leg\'s own field issue', () => {
      const parsed = body.safeParse({ quotaNotice: true, orgId: ORG, subject: '', text: 't' });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]).toMatchObject({ path: ['subject'], message: 'is required' });
    });
  });

  it('carries the routes\' own 400 messages', () => {
    const q = PLATFORM_INTERNAL.ecosystemApprovers.query!;
    expect(q.safeParse({ permission: 'x', excludeOrgIds: 'bad' }).error?.issues[0]?.message)
      .toBe('permission must be one of: plugins:moderate, publishers:verify');
    expect(q.safeParse({ permission: 'plugins:moderate', excludeUserIds: ['a'] }).error?.issues[0]?.message)
      .toBe('excludeOrgIds / excludeUserIds must be comma-separated ids (at most 20)');
    const posture = PLATFORM_INTERNAL.reportAccessPosture.query!;
    expect(posture.safeParse({ from: 'x', to: 'y' }).error?.issues[0]?.message).toBe('from and to must both be ISO timestamps');
    expect(posture.safeParse({ from: '2026-02-01', to: '2026-01-01' }).error?.issues[0]?.message).toBe('from must be before to');
    expect(PLATFORM_INTERNAL.orgAIKey.params.safeParse({ orgId: 'system', provider: 'nope' }).error?.issues[0]?.message)
      .toBe('provider must be a key-based AI provider');
  });

  it('normalizes replies the way their clients always read them', () => {
    expect(PLATFORM_INTERNAL.orgAIAccess.response.parse({ aiEnabled: true, providers: ['anthropic', 7] }))
      .toEqual({ aiEnabled: true, providers: ['anthropic'] });
    expect(PLATFORM_INTERNAL.supportEntitlement.response.safeParse({ level: null, canOpenCase: false }).success).toBe(false);
    expect(PLATFORM_INTERNAL.offerSeatActivity.query!.parse({ windowDays: '9999' })).toEqual({ windowDays: 365 });
    expect(PLATFORM_INTERNAL.offerSeatActivity.query!.parse({ windowDays: 'abc' })).toEqual({ windowDays: 30 });
  });
});
