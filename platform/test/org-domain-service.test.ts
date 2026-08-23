// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDomainFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockDomainFind = jest.fn<(...a: unknown[]) => unknown>();
const mockDomainCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDomainDeleteOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDomainDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockDomainCount = jest.fn<(...a: unknown[]) => Promise<number>>();
const mockJoinFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockJoinUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockJoinUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockJoinDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserFind = jest.fn<(...a: unknown[]) => unknown>();
const mockResolveTxt = jest.fn<(...a: unknown[]) => Promise<string[][]>>();
const mockResolveLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();
const mockSeatAvailable = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockSeatStillWithin = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockUserHasSeat = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<void>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('dns', () => ({ promises: { resolveTxt: (...a: unknown[]) => mockResolveTxt(...a) } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  OrgDomain: {
    findOne: (...a: unknown[]) => mockDomainFindOne(...a),
    find: (...a: unknown[]) => mockDomainFind(...a),
    create: (...a: unknown[]) => mockDomainCreate(...a),
    deleteOne: (...a: unknown[]) => mockDomainDeleteOne(...a),
    deleteMany: (...a: unknown[]) => mockDomainDeleteMany(...a),
    countDocuments: (...a: unknown[]) => mockDomainCount(...a),
  },
  JoinRequest: {
    findOne: (...a: unknown[]) => mockJoinFindOne(...a),
    updateOne: (...a: unknown[]) => mockJoinUpdateOne(...a),
    updateMany: (...a: unknown[]) => mockJoinUpdateMany(...a),
    deleteMany: (...a: unknown[]) => mockJoinDeleteMany(...a),
    find: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }),
  },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a), find: (...a: unknown[]) => mockOrgFind(...a) },
  UserOrganization: {
    findOne: (...a: unknown[]) => mockUserOrgFindOne(...a),
    find: (...a: unknown[]) => mockUserOrgFind(...a),
    create: (...a: unknown[]) => mockUserOrgCreate(...a),
  },
  User: { find: (...a: unknown[]) => mockUserFind(...a), findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) },
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { sendJoinRequestReceived: jest.fn(), sendJoinRequestDecision: jest.fn() },
}));
jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({ sendInAppNotification: jest.fn() }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn({}),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ emailDomain: (e: string) => (e.includes('@') ? e.split('@')[1].toLowerCase() : null) }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: (...a: unknown[]) => mockSeatAvailable(...a),
  seatCapacityStillWithinCap: (...a: unknown[]) => mockSeatStillWithin(...a),
  userHasSeatInAccount: (...a: unknown[]) => mockUserHasSeat(...a),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a) }));

const svc = await import('../src/services/org-domain-service.js');
const { orgDomainService } = svc;

const entitledOrg = (over: Record<string, unknown> = {}) =>
  ({ select: () => ({ lean: () => Promise.resolve({ tier: 'team', name: 'Acme', deletedAt: null, ...over }) }) });
const discoverable = (autoJoin = 'request') =>
  ({ lean: () => Promise.resolve([{ orgId: 'org-1', domain: 'acme.com', autoJoin }]) });
// The batch org fetch in findDiscoverableOrgsByEmail (Organization.find(...).select().lean()).
// Valid 24-hex ObjectIds for the id-shape guards (isValidObjectId).
const DID = '0123456789abcdef01234567';
const RID = '0123456789abcdef01234568';
const orgBatch = (rows: Array<Record<string, unknown>> = [{ _id: 'org-1', name: 'Acme', deletedAt: null }]) =>
  ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLineage.mockResolvedValue({ rootOrgId: 'org-1' });
  mockOrgFindById.mockReturnValue(entitledOrg());
  mockOrgFind.mockReturnValue(orgBatch());
  mockUserOrgFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  mockUserFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  mockSeatAvailable.mockResolvedValue(true);
  mockSeatStillWithin.mockResolvedValue(true);
  mockUserHasSeat.mockResolvedValue(false);
  mockEnsureBaselineRole.mockResolvedValue();
  mockDomainCount.mockResolvedValue(0);
  mockDomainDeleteMany.mockResolvedValue({});
  mockJoinUpdateOne.mockResolvedValue({});
  mockJoinUpdateMany.mockResolvedValue({});
  mockJoinDeleteMany.mockResolvedValue({});
});

describe('addDomain', () => {
  it('creates an unverified domain with a token when entitled and free', async () => {
    mockDomainFindOne.mockResolvedValue(null); // mine, verifiedElsewhere
    mockDomainCreate.mockImplementation(async (d: any) => ({ _id: 'd1', ...d }));
    const doc: any = await orgDomainService.addDomain('org-1', 'Acme.com', 'user-1');
    expect(doc.domain).toBe('acme.com');
    expect(doc.verificationToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a freemail/public domain', async () => {
    await expect(orgDomainService.addDomain('org-1', 'gmail.com', 'u1')).rejects.toThrow(svc.DOMAIN_PUBLIC);
  });

  it('rejects when the account tier is not entitled', async () => {
    mockOrgFindById.mockReturnValue(entitledOrg({ tier: 'developer' }));
    await expect(orgDomainService.addDomain('org-1', 'acme.com', 'u1')).rejects.toThrow(svc.DOMAIN_NOT_ENTITLED);
  });

  it('is idempotent for the same org', async () => {
    mockDomainFindOne.mockResolvedValueOnce({ orgId: 'org-1', domain: 'acme.com' }); // mine
    const doc: any = await orgDomainService.addDomain('org-1', 'acme.com', 'u1');
    expect(doc.orgId).toBe('org-1');
    expect(mockDomainCreate).not.toHaveBeenCalled();
  });

  it('rejects a domain already VERIFIED by another org', async () => {
    mockDomainFindOne
      .mockResolvedValueOnce(null)                                   // mine
      .mockResolvedValueOnce({ orgId: 'org-2', verified: true });    // verifiedElsewhere
    await expect(orgDomainService.addDomain('org-1', 'acme.com', 'u1')).rejects.toThrow(svc.DOMAIN_TAKEN);
  });

  it('enforces a per-org domain cap', async () => {
    mockDomainFindOne.mockResolvedValue(null);
    mockDomainCount.mockResolvedValue(20);
    await expect(orgDomainService.addDomain('org-1', 'acme.com', 'u1')).rejects.toThrow(svc.DOMAIN_LIMIT);
  });
});

describe('verifyDomain', () => {
  it('verifies on TXT match and evicts other unverified claims', async () => {
    const save = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    mockDomainFindOne
      .mockResolvedValueOnce({ _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: false, verificationToken: 'tok', save }) // by id
      .mockResolvedValueOnce(null); // verifiedElsewhere race check
    mockResolveTxt.mockResolvedValue([['pb-verify=tok']]);
    const doc: any = await orgDomainService.verifyDomain('org-1', DID);
    expect(doc.verified).toBe(true);
    expect(mockDomainDeleteMany).toHaveBeenCalledWith(expect.objectContaining({ domain: 'acme.com', verified: false }));
  });

  it('fails when the TXT record is absent/mismatched', async () => {
    mockDomainFindOne.mockResolvedValueOnce({ _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: false, verificationToken: 'tok', save: jest.fn() }).mockResolvedValueOnce(null);
    mockResolveTxt.mockResolvedValue([['pb-verify=WRONG']]);
    await expect(orgDomainService.verifyDomain('org-1', DID)).rejects.toThrow(svc.DOMAIN_VERIFY_FAILED);
  });

  it('fails (not hangs) when DNS rejects', async () => {
    mockDomainFindOne.mockResolvedValueOnce({ _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: false, verificationToken: 'tok', save: jest.fn() }).mockResolvedValueOnce(null);
    mockResolveTxt.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(orgDomainService.verifyDomain('org-1', DID)).rejects.toThrow(svc.DOMAIN_VERIFY_FAILED);
  });

  it('throws DOMAIN_NOT_FOUND for an unknown domain', async () => {
    mockDomainFindOne.mockResolvedValueOnce(null);
    await expect(orgDomainService.verifyDomain('org-1', DID)).rejects.toThrow(svc.DOMAIN_NOT_FOUND);
  });
});

describe('setDomainMode', () => {
  it('refuses a non-off mode on an unverified domain', async () => {
    mockDomainFindOne.mockResolvedValue({ _id: 'd1', orgId: 'org-1', verified: false, save: jest.fn() });
    await expect(orgDomainService.setDomainMode('org-1', DID, 'auto')).rejects.toThrow(svc.DOMAIN_NOT_VERIFIED);
  });

  it('sets a mode on a verified, entitled domain', async () => {
    const save = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    mockDomainFindOne.mockResolvedValue({ _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: true, autoJoin: 'off', save });
    const out: any = await orgDomainService.setDomainMode('org-1', DID, 'auto');
    expect(out.autoJoin).toBe('auto');
  });

  it('cancels pending requests when set to off', async () => {
    const save = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    mockDomainFindOne.mockResolvedValue({ _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: true, autoJoin: 'auto', save });
    await orgDomainService.setDomainMode('org-1', DID, 'off');
    expect(mockJoinDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', status: 'pending' }),
    );
  });
});

describe('deleteDomain', () => {
  it('deletes and cancels that domain’s pending requests', async () => {
    mockDomainFindOne.mockResolvedValue({ _id: 'd1', orgId: 'org-1', domain: 'acme.com' });
    mockDomainDeleteOne.mockResolvedValue({ deletedCount: 1 });
    await orgDomainService.deleteDomain('org-1', DID);
    expect(mockDomainDeleteOne).toHaveBeenCalled();
    expect(mockJoinDeleteMany).toHaveBeenCalled();
  });

  it('throws when the domain is missing', async () => {
    mockDomainFindOne.mockResolvedValue(null);
    await expect(orgDomainService.deleteDomain('org-1', DID)).rejects.toThrow(svc.DOMAIN_NOT_FOUND);
  });
});

describe('findDiscoverableOrgsByEmail', () => {
  it('returns only verified, non-off, entitled orgs', async () => {
    mockDomainFind.mockReturnValue(discoverable('request'));
    expect(await orgDomainService.findDiscoverableOrgsByEmail('jane@acme.com')).toEqual([{ orgId: 'org-1', orgName: 'Acme', autoJoin: 'request' }]);
  });

  it('excludes an org whose tier is not entitled', async () => {
    mockDomainFind.mockReturnValue(discoverable('auto'));
    mockOrgFindById.mockReturnValue(entitledOrg({ tier: 'pro' }));
    expect(await orgDomainService.findDiscoverableOrgsByEmail('jane@acme.com')).toEqual([]);
  });

  it('returns nothing for an address with no domain', async () => {
    expect(await orgDomainService.findDiscoverableOrgsByEmail('bogus')).toEqual([]);
  });
});

describe('requestOrAutoJoin', () => {
  const user = { _id: new Types.ObjectId(), email: 'jane@acme.com' };

  it('rejects a join the user is not eligible for (server re-check)', async () => {
    mockDomainFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    await expect(orgDomainService.requestOrAutoJoin(user, 'org-1')).rejects.toThrow(svc.JOIN_NOT_ELIGIBLE);
  });

  it('auto-joins (seat-checked member) for autoJoin=auto', async () => {
    mockDomainFind.mockReturnValue(discoverable('auto'));
    mockUserOrgFindOne
      .mockReturnValueOnce({ lean: () => Promise.resolve(null) })      // already-member pre-check
      .mockReturnValueOnce({ session: () => Promise.resolve(null) });  // in-tx existing
    mockJoinFindOne.mockReturnValue({ lean: () => Promise.resolve(null) }); // prior request
    const res = await orgDomainService.requestOrAutoJoin(user, 'org-1');
    expect(res).toEqual({ joined: true, status: 'joined' });
    expect(mockUserOrgCreate).toHaveBeenCalled();
  });

  it('files a pending request for autoJoin=request', async () => {
    mockDomainFind.mockReturnValue(discoverable('request'));
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockJoinFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const res = await orgDomainService.requestOrAutoJoin(user, 'org-1');
    expect(res.status).toBe('requested');
    expect(mockJoinUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'pending' }) }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('keeps a prior denial sticky (no self-reopen)', async () => {
    mockDomainFind.mockReturnValue(discoverable('request'));
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockJoinFindOne.mockReturnValue({ lean: () => Promise.resolve({ status: 'denied' }) });
    const res = await orgDomainService.requestOrAutoJoin(user, 'org-1');
    expect(res.status).toBe('denied');
    expect(mockJoinUpdateOne).not.toHaveBeenCalled();
  });

  it('falls back to a request when auto-join hits a revoked membership', async () => {
    mockDomainFind.mockReturnValue(discoverable('auto'));
    mockUserOrgFindOne
      .mockReturnValueOnce({ lean: () => Promise.resolve(null) })                        // already-member pre-check
      .mockReturnValueOnce({ session: () => Promise.resolve({ isActive: false }) });     // in-tx: deactivated membership
    mockJoinFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const res = await orgDomainService.requestOrAutoJoin(user, 'org-1');
    expect(res.status).toBe('requested');
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
  });

  it('reports already-member without creating anything', async () => {
    mockDomainFind.mockReturnValue(discoverable('auto'));
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'm1' }) });
    const res = await orgDomainService.requestOrAutoJoin(user, 'org-1');
    expect(res.status).toBe('already-member');
  });

  it('throws JOIN_SEAT_LIMIT when the account is at capacity', async () => {
    mockDomainFind.mockReturnValue(discoverable('auto'));
    // Robust (both methods) so the seat-limit throw before the in-tx findOne
    // doesn't leave an unconsumed once-value that leaks into the next test.
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve(null), session: () => Promise.resolve(null) });
    mockJoinFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockSeatAvailable.mockResolvedValue(false);
    await expect(orgDomainService.requestOrAutoJoin(user, 'org-1')).rejects.toThrow(svc.JOIN_SEAT_LIMIT);
  });
});

describe('reverifyStaleDomains', () => {
  const staleDoc = (over: Record<string, unknown> = {}) => ({
    _id: 'd1', orgId: 'org-1', domain: 'acme.com', verified: true, verificationToken: 'tok', autoJoin: 'auto',
    save: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined), ...over,
  });

  it('un-verifies + disables a domain whose TXT proof is definitively gone', async () => {
    const doc = staleDoc();
    mockDomainFind.mockReturnValue({ limit: () => Promise.resolve([doc]) });
    mockResolveTxt.mockResolvedValue([['pb-verify=DIFFERENT']]); // resolves, but token missing
    const res = await orgDomainService.reverifyStaleDomains(1000);
    expect(res).toEqual({ checked: 1, unverified: 1 });
    expect(doc.verified).toBe(false);
    expect(doc.autoJoin).toBe('off');
    expect(mockJoinDeleteMany).toHaveBeenCalled(); // pending requests denied
  });

  it('leaves a domain verified on a transient DNS error (no un-verify)', async () => {
    const doc = staleDoc();
    mockDomainFind.mockReturnValue({ limit: () => Promise.resolve([doc]) });
    mockResolveTxt.mockRejectedValue(new Error('ESERVFAIL'));
    const res = await orgDomainService.reverifyStaleDomains(1000);
    expect(res.unverified).toBe(0);
    expect(doc.verified).toBe(true);
  });

  it('resets the clock when the record still matches', async () => {
    const doc = staleDoc();
    mockDomainFind.mockReturnValue({ limit: () => Promise.resolve([doc]) });
    mockResolveTxt.mockResolvedValue([['pb-verify=tok']]);
    const res = await orgDomainService.reverifyStaleDomains(1000);
    expect(res.unverified).toBe(0);
    expect(doc.verified).toBe(true);
    expect(doc.save).toHaveBeenCalled();
  });
});

describe('decideJoinRequest', () => {
  const decider = new Types.ObjectId().toString();

  it('approves → re-validates eligibility, creates membership, marks approved', async () => {
    const save = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    mockJoinFindOne.mockResolvedValue({ _id: 'r1', orgId: 'org-1', userId: new Types.ObjectId(), email: 'jane@acme.com', status: 'pending', save });
    mockDomainFind.mockReturnValue(discoverable('request')); // still eligible
    // Robust: the pre-check uses .lean(), the in-tx guard uses .session() — both null.
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve(null), session: () => Promise.resolve(null) });
    const res = await orgDomainService.decideJoinRequest('org-1', RID, 'approve', decider);
    expect(res.status).toBe('approved');
    expect(mockUserOrgCreate).toHaveBeenCalled();
  });

  it('refuses to approve when the domain is no longer discoverable', async () => {
    mockJoinFindOne.mockResolvedValue({ _id: 'r1', orgId: 'org-1', userId: new Types.ObjectId(), email: 'jane@acme.com', status: 'pending', save: jest.fn() });
    mockDomainFind.mockReturnValue({ lean: () => Promise.resolve([]) }); // no longer eligible
    await expect(orgDomainService.decideJoinRequest('org-1', RID, 'approve', decider)).rejects.toThrow(svc.JOIN_NOT_ELIGIBLE);
  });

  it('denies without creating a membership', async () => {
    const save = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    mockJoinFindOne.mockResolvedValue({ _id: 'r1', orgId: 'org-1', userId: new Types.ObjectId(), email: 'jane@acme.com', status: 'pending', save });
    const res = await orgDomainService.decideJoinRequest('org-1', RID, 'deny', decider);
    expect(res.status).toBe('denied');
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
  });

  it('throws when the request is missing or already decided', async () => {
    mockJoinFindOne.mockResolvedValue(null);
    await expect(orgDomainService.decideJoinRequest('org-1', RID, 'approve', decider)).rejects.toThrow(svc.JOIN_REQUEST_NOT_FOUND);
  });
});
