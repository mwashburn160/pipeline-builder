// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints message SERVES (api-core
 * `MESSAGE_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  MESSAGE_INTERNAL,
  buildRouteTable,
  internalContractsServedBy,
  notifyBodyErrorCode,
  type RouteTableEntry,
  type SseTicketStore,
} from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof MESSAGE_INTERNAL, ContractSample> = {
  notify: {
    body: { recipientOrgId: 'org-1', recipientUserId: 'user-1', subject: 'Renewal', content: 'Your plan renews soon.', priority: 'high' },
    response: { id: 'msg-1' },
  },
  purgeOrgAttachments: {
    params: { orgId: 'org-1' },
    response: { orgId: 'org-1', deleted: 3 },
  },
  purgeOrgData: {
    params: { orgId: 'org-1' },
    response: { orgId: 'org-1', tables: { messages: 4, support_cases: 1 } },
  },
  offersFrustration: {
    params: { orgId: 'org-1' },
    response: {
      signal: { orgId: 'org-1', windowDays: 30, sampled: 4, frustrated: false, confidence: 0.2, degraded: false, promptVersion: 'v1' },
    },
  },
};

let table: RouteTableEntry[];
let ticketStore: SseTicketStore | undefined;

beforeAll(async () => {
  const [{ createApp }, { createQuotaService, createEnvSseTicketStore, SSE_TICKET_TTL_MS }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false });
  ticketStore = createEnvSseTicketStore({ ttlMs: SSE_TICKET_TTL_MS, maxTotal: 10, maxPerOrg: 2 });
  mountRoutes(app, { quotaService: createQuotaService(), sseManager, ticketStore });
  table = buildRouteTable(app);
});

afterAll(() => {
  ticketStore?.stop();
});

describe('message internal endpoint contracts', () => {
  it('has a sample for every contract message serves', () => {
    expect(internalContractsServedBy('message').map((c) => c.id).sort())
      .toEqual(Object.values(MESSAGE_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(MESSAGE_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    const sample = SAMPLES[name as keyof typeof MESSAGE_INTERNAL];
    expect(() => roundTripContractSample(contract, sample)).not.toThrow();
  });

  it('normalizes the notify body the way the route always has', () => {
    const parsed = MESSAGE_INTERNAL.notify.body!.parse({ recipientOrgId: ' ORG-1 ', recipientUserId: '  ', subject: ' s ', content: 'c', extra: 1 });
    expect(parsed).toEqual({ recipientOrgId: 'org-1', subject: 's', content: 'c' });
  });

  it.each([
    ['a missing field', { subject: 's', content: 'c' }, 'recipientOrgId, subject and content are required', 'MISSING_REQUIRED_FIELD'],
    ['a non-object body', 'not-an-object', 'recipientOrgId, subject and content are required', 'MISSING_REQUIRED_FIELD'],
    ['the broadcast recipient', { recipientOrgId: '*', subject: 's', content: 'c' }, 'recipientOrgId "*" is reserved for announcements', 'VALIDATION_ERROR'],
    ['an over-long subject', { recipientOrgId: 'o', subject: 'x'.repeat(501), content: 'c' }, 'subject or content exceeds the maximum length', 'VALIDATION_ERROR'],
    ['an unknown priority', { recipientOrgId: 'o', subject: 's', content: 'c', priority: 'meh' }, 'priority must be one of: normal, high, urgent', 'VALIDATION_ERROR'],
  ])('rejects %s with the route\'s own message and code', (_label, body, message, code) => {
    const parsed = MESSAGE_INTERNAL.notify.body!.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0]?.message).toBe(message);
    expect(notifyBodyErrorCode(parsed.error)).toBe(code);
  });

  it('defaults an unclassified issue to VALIDATION_ERROR', () => {
    expect(notifyBodyErrorCode(undefined)).toBe('VALIDATION_ERROR');
  });
});
