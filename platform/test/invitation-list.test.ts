// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for InvitationService.listForOrg — the paginated, filterable
 * invitation list read.
 *
 * The behavior under test: status/type/role filters and a case-insensitive
 * email `search` are pushed into the DB query (never applied in memory), each
 * gated by a whitelist so a hostile value can't inject an arbitrary field, and
 * the page is bounded by skip/limit with the full filtered `total` returned.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { invitation: { expirationDays: 7, maxPendingPerOrg: 50 } },
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(async () => true),
  seatCapacityStillWithinCap: jest.fn(async () => true),
  userHasSeatInAccount: jest.fn(async () => false),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn(async () => undefined), assignBuiltinAdminRole: jest.fn(async () => true), recomputeUserOrgRole: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/utils/email.js', () => ({ emailService: { sendInvitation: jest.fn(async () => true) } }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
// Identity escape keeps the email-search-regex assertions simple.
jest.unstable_mockModule('../src/utils/regex.js', () => ({ escapeRegex: (s: string) => s }));

const mockInvFind = jest.fn<(...a: unknown[]) => unknown>();
const mockInvCount = jest.fn<(...a: unknown[]) => Promise<number>>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  Invitation: {
    find: (...a: unknown[]) => mockInvFind(...a),
    countDocuments: (...a: unknown[]) => mockInvCount(...a),
  },
  Organization: {},
  User: {},
  UserOrganization: {},
}));

const { invitationService } = await import('../src/services/invitation-service.js');

// `Invitation.find(...).populate().populate().sort().skip().limit().lean()`.
let capturedSkip: number | undefined;
let capturedLimit: number | undefined;
const invQuery = (rows: unknown[]) => {
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  q.populate = () => q;
  q.sort = () => q;
  q.skip = (n: unknown) => { capturedSkip = n as number; return q; };
  q.limit = (n: unknown) => { capturedLimit = n as number; return q; };
  q.lean = () => Promise.resolve(rows);
  return q;
};

const invites = [{ _id: 'inv-1', email: 'alice@x.com', role: 'admin', status: 'pending' }];

beforeEach(() => {
  jest.clearAllMocks();
  capturedSkip = undefined;
  capturedLimit = undefined;
  mockInvFind.mockReturnValue(invQuery(invites));
  mockInvCount.mockResolvedValue(7);
});

/** The filter object the service built for this call. */
const filterArg = () => mockInvFind.mock.calls[0][0] as Record<string, unknown>;

describe('InvitationService.listForOrg', () => {
  it('bounds the query with offset/limit and returns the full total', async () => {
    const { invitations, total } = await invitationService.listForOrg('org-1', { offset: 10, limit: 5 });
    expect(capturedSkip).toBe(10);
    expect(capturedLimit).toBe(5);
    expect(total).toBe(7);
    expect(invitations).toHaveLength(1);
  });

  it('always scopes to the organization', async () => {
    await invitationService.listForOrg('org-1', { offset: 0, limit: 25 });
    expect(filterArg()).toMatchObject({ organizationId: 'org-1' });
  });

  it('applies whitelisted status / type / role filters', async () => {
    await invitationService.listForOrg('org-1', {
      status: 'pending', invitationType: 'email', role: 'admin', offset: 0, limit: 25,
    });
    expect(filterArg()).toMatchObject({ status: 'pending', invitationType: 'email', role: 'admin' });
  });

  it('ignores unrecognized status / type / role values', async () => {
    await invitationService.listForOrg('org-1', {
      status: 'bogus', invitationType: 'carrier-pigeon', role: 'superuser', offset: 0, limit: 25,
    });
    const f = filterArg();
    expect(f).not.toHaveProperty('status');
    expect(f).not.toHaveProperty('invitationType');
    expect(f).not.toHaveProperty('role');
  });

  it('matches the invitee email case-insensitively (escaped substring)', async () => {
    await invitationService.listForOrg('org-1', { search: 'Alice', offset: 0, limit: 25 });
    const email = filterArg().email as RegExp;
    expect(email).toBeInstanceOf(RegExp);
    expect(email.flags).toContain('i'); // case-insensitive
    expect(email.source).toBe('Alice');
    expect(email.test('alice@example.com')).toBe(true); // matches regardless of case
  });

  it('omits the email filter when search is blank', async () => {
    await invitationService.listForOrg('org-1', { search: '   ', offset: 0, limit: 25 });
    expect(filterArg()).not.toHaveProperty('email');
  });
});
