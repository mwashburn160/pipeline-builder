// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `services/mfa-recovery.ts` — the factor reset itself, and the TWO-PERSON rule
 * that guards it.
 *
 * The HTTP layer is covered in `mfa-reset-controller.test.ts` (with this service
 * mocked), and the atomic claim is proven against a real replica set in
 * `mfa-reset.integration.test.ts`. What was missing is the layer in between: the
 * policy decisions this module makes, on every run of the default suite.
 *
 * Both failure directions are security-critical and pull in opposite directions:
 * a reset that skips an authority check is an account-takeover path (one admin
 * strips a colleague's factors alone, or a tenant admin strips a PLATFORM
 * operator's), and a reset that refuses an authorized approver is a permanent
 * lockout. So every rule below is asserted from both sides.
 *
 * The models are a small in-memory double rather than a pile of per-test
 * `mockResolvedValue`s: the two-person rule is expressed as a conditional
 * `findOneAndUpdate` claim, and only a store that actually evaluates the filter
 * can tell "the claim refused it" from "the stub returned null".
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// A minimal Mongo double: enough operators for the filters this module builds.
// ---------------------------------------------------------------------------

/** Compare ids/dates the way Mongo does, not the way `===` does. */
const sid = (v: unknown): unknown => (v instanceof Types.ObjectId ? String(v) : v);

function matches(doc: any, filter: Record<string, any> = {}): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof Types.ObjectId) && !Array.isArray(cond)) {
      if ('$in' in cond) return (cond.$in as unknown[]).some((x) => String(sid(x)) === String(sid(value)));
      if ('$ne' in cond) return String(sid(cond.$ne)) !== String(sid(value));
      if ('$gt' in cond) return new Date(value).getTime() > new Date(cond.$gt).getTime();
      if ('$lte' in cond) return new Date(value).getTime() <= new Date(cond.$lte).getTime();
    }
    return String(sid(cond)) === String(sid(value));
  });
}

function applyUpdate(doc: any, update: Record<string, any> = {}): void {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) for (const key of Object.keys(update.$unset)) delete doc[key];
  if (update.$inc) for (const [key, by] of Object.entries(update.$inc)) doc[key] = (doc[key] ?? 0) + (by as number);
}

/** A chainable query double — `select`/`sort`/`limit`/`lean` all no-ops. */
function query<T>(resolve: () => T): any {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    skip: () => chain,
    session: () => chain,
    lean: () => chain,
    then: (ok: any, fail: any) => Promise.resolve().then(resolve).then(ok, fail),
    catch: (fail: any) => Promise.resolve().then(resolve).catch(fail),
  };
  return chain;
}

const copy = <T>(doc: T | null | undefined): T | null => (doc ? { ...(doc as object) } as T : null);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface UserRec { _id: Types.ObjectId; email: string; isSuperAdmin?: boolean; tokenVersion: number; refreshSessions: unknown[]; mfaResetGraceUntil?: Date }

const db = {
  users: [] as UserRec[],
  memberships: [] as Array<{ userId: Types.ObjectId; organizationId: string; isActive: boolean }>,
  requests: [] as any[],
  passkeys: new Map<string, number>(),
  totp: new Set<string>(),
  codes: new Set<string>(),
};

const findUser = (id: unknown) => db.users.find((u) => String(u._id) === String(id)) ?? null;

const User = {
  findById: jest.fn((id: unknown) => query(() => copy(findUser(id)))),
  findOne: jest.fn((filter: any) => query(() => copy(db.users.find((u) => matches(u, filter)) ?? null))),
  findByIdAndUpdate: jest.fn((id: unknown, update: any, _opts?: unknown) => query(() => {
    const user = findUser(id);
    if (!user) return null;
    applyUpdate(user, update);
    return copy(user);
  })),
};

const UserOrganization = {
  exists: jest.fn(async (filter: any) => {
    const hit = db.memberships.find((m) => matches(m, filter));
    return hit ? { _id: new Types.ObjectId() } : null;
  }),
};

const WebAuthnCredential = {
  deleteMany: jest.fn(async ({ userId }: { userId: string }) => {
    const n = db.passkeys.get(String(userId)) ?? 0;
    db.passkeys.delete(String(userId));
    return { deletedCount: n };
  }),
};
const UserTotp = {
  deleteOne: jest.fn(async ({ userId }: { userId: string }) => ({ deletedCount: db.totp.delete(String(userId)) ? 1 : 0 })),
};
const MfaRecoveryCodes = {
  deleteOne: jest.fn(async ({ userId }: { userId: string }) => ({ deletedCount: db.codes.delete(String(userId)) ? 1 : 0 })),
};

const MfaResetRequest = {
  create: jest.fn(async (doc: any) => {
    // The partial unique index: one PENDING request per (org, member).
    const clash = db.requests.some((r) => r.status === 'pending'
      && r.organizationId === doc.organizationId && String(r.targetUserId) === String(doc.targetUserId));
    if (clash) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const rec = {
      ...doc,
      _id: new Types.ObjectId(),
      targetUserId: new Types.ObjectId(doc.targetUserId),
      requestedBy: new Types.ObjectId(doc.requestedBy),
    };
    db.requests.push(rec);
    return { ...rec, toObject: () => ({ ...rec }) };
  }),
  findById: jest.fn((id: unknown) => query(() => copy(db.requests.find((r) => String(r._id) === String(id)) ?? null))),
  find: jest.fn((filter: any) => query(() => db.requests.filter((r) => matches(r, filter)).map((r) => ({ ...r })))),
  findOneAndUpdate: jest.fn((filter: any, update: any, _opts?: unknown) => query(() => {
    const hit = db.requests.find((r) => matches(r, filter));
    if (!hit) return null;
    applyUpdate(hit, update);
    return copy(hit);
  })),
  findByIdAndUpdate: jest.fn((id: unknown, update: any, _opts?: unknown) => query(() => {
    const hit = db.requests.find((r) => String(r._id) === String(id));
    if (!hit) return null;
    applyUpdate(hit, update);
    return copy(hit);
  })),
  updateOne: jest.fn(async (filter: any, update: any) => {
    const hit = db.requests.find((r) => matches(r, filter));
    if (hit) applyUpdate(hit, update);
    return { modifiedCount: hit ? 1 : 0 };
  }),
  updateMany: jest.fn(async (filter: any, update: any) => {
    const hits = db.requests.filter((r) => matches(r, filter));
    for (const hit of hits) applyUpdate(hit, update);
    return { modifiedCount: hits.length };
  }),
};

const mockCreateEvent = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
const mockPublishRevocation = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/services/audit-service.js', () => ({
  auditService: { createEvent: (...a: unknown[]) => mockCreateEvent(...a) },
}));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: (...a: unknown[]) => mockPublishRevocation(...a),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  MfaRecoveryCodes, MfaResetRequest, User, UserOrganization, UserTotp, WebAuthnCredential,
}));

const svc = await import('../src/services/mfa-recovery.js');
const { MFA_RESET_GRACE_MAX_HOURS } = await import('../src/helpers/mfa-policy.js');
const { MFA_RESET_ALREADY_PENDING, MFA_RESET_EXPIRED, MFA_RESET_NOT_FOUND, MFA_RESET_NOT_MEMBER, MFA_RESET_NOT_PENDING, MFA_RESET_PLATFORM_ADMIN, MFA_RESET_SECOND_PERSON_REQUIRED, MFA_RESET_SELF } = await import('../src/services/mfa-recovery-errors.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'acme';
const ADMIN_1 = '651111111111111111111111';
const ADMIN_2 = '652222222222222222222222';
const MEMBER = '653333333333333333333333';
const SYSADMIN = '654444444444444444444444';
const GONE = '659999999999999999999999';

const actor = (id: string, email: string, isSuperAdmin = false) => ({ id, email, isSuperAdmin });

function seedUser(id: string, email: string, over: Partial<UserRec> = {}): UserRec {
  const rec: UserRec = { _id: new Types.ObjectId(id), email, tokenVersion: 3, refreshSessions: [{ sid: 'a' }], ...over };
  db.users.push(rec);
  return rec;
}

/** File a pending request for MEMBER by ADMIN_1 and return its id. */
async function fileRequest(reason = 'Lost phone and laptop'): Promise<string> {
  const view = await svc.requestMfaReset({
    organizationId: ORG,
    targetUserId: MEMBER,
    requester: actor(ADMIN_1, 'a1@acme.test'),
    reason,
  });
  return view.id;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.users = [];
  db.memberships = [];
  db.requests = [];
  db.passkeys = new Map([[MEMBER, 2]]);
  db.totp = new Set([MEMBER]);
  db.codes = new Set([MEMBER]);

  seedUser(ADMIN_1, 'a1@acme.test');
  seedUser(ADMIN_2, 'a2@acme.test');
  seedUser(MEMBER, 'member@acme.test');
  seedUser(SYSADMIN, 'root@pipeline-builder.test', { isSuperAdmin: true });
  db.memberships.push(
    { userId: new Types.ObjectId(ADMIN_1), organizationId: ORG, isActive: true },
    { userId: new Types.ObjectId(ADMIN_2), organizationId: ORG, isActive: true },
    { userId: new Types.ObjectId(MEMBER), organizationId: ORG, isActive: true },
    { userId: new Types.ObjectId(SYSADMIN), organizationId: ORG, isActive: true },
  );
});

// ---------------------------------------------------------------------------

describe('resetFactors — what a reset actually does', () => {
  it('removes every factor, ends every session and grants the enrolment grace', async () => {
    const before = Date.now();
    const result = await svc.resetFactors(MEMBER);

    expect(result).toMatchObject({
      userId: MEMBER,
      email: 'member@acme.test',
      passkeysRemoved: 2,
      totpRemoved: true,
      recoveryCodesRemoved: true,
      // Bumped, not merely re-read: every older access token is dead.
      tokenVersion: 4,
    });
    const user = findUser(MEMBER)!;
    // "Sign out everywhere" is BOTH halves — a bump with live refresh slots
    // would let the holder mint a fresh token straight back.
    expect(user.refreshSessions).toEqual([]);
    expect(user.mfaResetGraceUntil).toEqual(result!.graceUntil);
    expect(result!.graceUntil.getTime() - before).toBeGreaterThanOrEqual(svc.MFA_RESET_GRACE_DEFAULT_HOURS * 3600_000 - 1000);
    // The stateless services only learn about the bump through the publish.
    expect(mockPublishRevocation).toHaveBeenCalledWith(MEMBER);
  });

  it('reports the factors that were NOT present rather than claiming them removed', async () => {
    db.passkeys.clear();
    db.totp.clear();
    db.codes.clear();
    const result = await svc.resetFactors(MEMBER);
    expect(result).toMatchObject({ passkeysRemoved: 0, totpRemoved: false, recoveryCodesRemoved: false });
  });

  it('returns null for an account that is gone, and touches nothing', async () => {
    expect(await svc.resetFactors(GONE)).toBeNull();
    expect(WebAuthnCredential.deleteMany).not.toHaveBeenCalled();
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('CLAMPS the grace an approver may grant: at least an hour, never past the max', async () => {
    const hours = async (requested: number) => {
      const r = await svc.resetFactors(MEMBER, requested);
      return Math.round((r!.graceUntil.getTime() - Date.now()) / 3600_000);
    };
    // Beyond a week an MFA-required org would have a member quietly exempt.
    expect(await hours(1000)).toBe(MFA_RESET_GRACE_MAX_HOURS);
    expect(await hours(0)).toBe(1);
    expect(await hours(-5)).toBe(1);
    expect(await hours(6)).toBe(6);
  });
});

describe('recoverMfa — the operator command', () => {
  it('resets by email and records the SELF-ASSERTED operator as the actor', async () => {
    const result = await svc.recoverMfa({ email: '  MEMBER@Acme.test ', operator: 'ops@corp.test' });

    expect(result).toMatchObject({ userId: MEMBER, passkeysRemoved: 2 });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auth.mfa.operator_reset',
      actorId: 'ops@corp.test',
      targetId: MEMBER,
      outcome: 'success',
      // The trail must say the actor is unverified — the command runs on
      // database access, not on a session.
      details: expect.objectContaining({ via: 'operator-command', operatorAsserted: true }),
    }));
  });

  it('returns null for an unknown address and writes no audit row', async () => {
    expect(await svc.recoverMfa({ email: 'nobody@acme.test', operator: 'ops@corp.test' })).toBeNull();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});

describe('requestMfaReset — who may be asked for, and by whom', () => {
  it('files a pending request with a 24h expiry', async () => {
    const view = await svc.requestMfaReset({
      organizationId: ORG, targetUserId: MEMBER, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'Lost phone',
    });
    expect(view).toMatchObject({
      organizationId: ORG,
      targetUserId: MEMBER,
      targetEmail: 'member@acme.test',
      requestedBy: ADMIN_1,
      requestedByEmail: 'a1@acme.test',
      status: 'pending',
      reason: 'Lost phone',
    });
    const ttl = new Date(view.expiresAt).getTime() - new Date(view.createdAt).getTime();
    expect(ttl).toBe(svc.MFA_RESET_REQUEST_TTL_MS);
  });

  it('REFUSES a request for oneself, before any database work', async () => {
    // Self-service here would make the two-person flow a way to remove your own
    // second factor with one person: yours.
    await expect(svc.requestMfaReset({
      organizationId: ORG, targetUserId: ADMIN_1, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r',
    })).rejects.toThrow(MFA_RESET_SELF);
    expect(UserOrganization.exists).not.toHaveBeenCalled();
  });

  it('REFUSES a platform administrator — a tenant\'s admins never strip an operator\'s factors', async () => {
    await expect(svc.requestMfaReset({
      organizationId: ORG, targetUserId: SYSADMIN, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r',
    })).rejects.toThrow(MFA_RESET_PLATFORM_ADMIN);
    expect(MfaResetRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a target who is not an ACTIVE member of the org', async () => {
    db.memberships = db.memberships.filter((m) => String(m.userId) !== MEMBER);
    await expect(svc.requestMfaReset({
      organizationId: ORG, targetUserId: MEMBER, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r',
    })).rejects.toThrow(MFA_RESET_NOT_MEMBER);
  });

  it('refuses a malformed target id without querying', async () => {
    await expect(svc.requestMfaReset({
      organizationId: ORG, targetUserId: 'not-an-id', requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r',
    })).rejects.toThrow(MFA_RESET_NOT_MEMBER);
    expect(UserOrganization.exists).not.toHaveBeenCalled();
  });

  it('refuses a member whose membership row outlived the account', async () => {
    db.users = db.users.filter((u) => String(u._id) !== MEMBER);
    await expect(svc.requestMfaReset({
      organizationId: ORG, targetUserId: MEMBER, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r',
    })).rejects.toThrow(MFA_RESET_NOT_MEMBER);
  });

  it('allows ONE pending request per member — a second is refused', async () => {
    await fileRequest();
    await expect(fileRequest()).rejects.toThrow(MFA_RESET_ALREADY_PENDING);
  });

  it('but a LAPSED request is expired first, so it never blocks a fresh one', async () => {
    await fileRequest();
    db.requests[0].expiresAt = new Date(Date.now() - 1000);

    const view = await svc.requestMfaReset({
      organizationId: ORG, targetUserId: MEMBER, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'Second attempt',
    });

    expect(view.status).toBe('pending');
    expect(db.requests.map((r) => r.status)).toEqual(['expired', 'pending']);
  });

  it('propagates a write failure that is not the uniqueness index', async () => {
    MfaResetRequest.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(fileRequest()).rejects.toThrow('connection reset');
  });
});

describe('listMfaResets / getMfaReset', () => {
  it('lists pending first, then decisions, and expires lapsed rows on the way past', async () => {
    const lapsed = await fileRequest();
    db.requests[0].expiresAt = new Date(Date.now() - 1000);
    await svc.requestMfaReset({
      organizationId: ORG, targetUserId: ADMIN_2, requester: actor(ADMIN_1, 'a1@acme.test'), reason: 'r2',
    });

    const list = await svc.listMfaResets([ORG]);

    expect(list[0].status).toBe('pending');
    expect(list.find((v) => v.id === lapsed)!.status).toBe('expired');
  });

  it('returns one request, with the decision and result once it has them', async () => {
    const id = await fileRequest();
    await svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') });

    const view = await svc.getMfaReset(id);

    expect(view).toMatchObject({
      status: 'approved',
      decidedBy: ADMIN_2,
      decidedByEmail: 'a2@acme.test',
      result: { passkeysRemoved: 2, totpRemoved: true, recoveryCodesRemoved: true },
    });
    expect(view.decidedAt).toEqual(expect.any(String));
  });

  it('answers NOT_FOUND for a missing or malformed id', async () => {
    await expect(svc.getMfaReset('nope')).rejects.toThrow(MFA_RESET_NOT_FOUND);
    await expect(svc.getMfaReset(GONE)).rejects.toThrow(MFA_RESET_NOT_FOUND);
  });
});

describe('approveMfaReset — the two-person rule', () => {
  it('a DIFFERENT admin approves, and the reset is carried out and recorded', async () => {
    const id = await fileRequest();

    const { request, result } = await svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') });

    expect(request.status).toBe('approved');
    expect(request.decidedBy).toBe(ADMIN_2);
    expect(result.tokenVersion).toBe(4);
    expect(findUser(MEMBER)!.refreshSessions).toEqual([]);
    expect(request.result).toEqual({
      passkeysRemoved: 2, totpRemoved: true, recoveryCodesRemoved: true, graceUntil: result.graceUntil.toISOString(),
    });
  });

  it('REFUSES the requester — one person may not play both parts', async () => {
    const id = await fileRequest();

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_1, 'a1@acme.test') }))
      .rejects.toThrow(MFA_RESET_SECOND_PERSON_REQUIRED);

    // Still pending, and no factor was touched.
    expect(db.requests[0].status).toBe('pending');
    expect(WebAuthnCredential.deleteMany).not.toHaveBeenCalled();
  });

  it('REFUSES the person being reset — otherwise the flow removes your own factors', async () => {
    const id = await fileRequest();

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(MEMBER, 'member@acme.test') }))
      .rejects.toThrow(MFA_RESET_SECOND_PERSON_REQUIRED);
    expect(db.requests[0].status).toBe('pending');
  });

  it('refuses a LAPSED request and marks it expired', async () => {
    const id = await fileRequest();
    db.requests[0].expiresAt = new Date(Date.now() - 1000);

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_EXPIRED);
    expect(db.requests[0].status).toBe('expired');
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('refuses a request that was already decided (no double approval)', async () => {
    const id = await fileRequest();
    await svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') });

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_PENDING);
  });

  it('reports an already-expired request as expired rather than "not pending"', async () => {
    const id = await fileRequest();
    db.requests[0].status = 'expired';
    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_EXPIRED);
  });

  it('answers NOT_FOUND for a malformed or unknown id', async () => {
    await expect(svc.approveMfaReset({ requestId: 'nope', approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
    await expect(svc.approveMfaReset({ requestId: GONE, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
  });

  it('RELEASES the claim when the reset itself fails, so the request can be retried', async () => {
    const id = await fileRequest();
    WebAuthnCredential.deleteMany.mockRejectedValueOnce(new Error('mongo down') as never);

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow('mongo down');

    // A stranded `approved` row would be unapprovable forever AND leave the
    // member with their factors — a lockout with no way back.
    expect(db.requests[0].status).toBe('pending');
    expect(db.requests[0].decidedBy).toBeUndefined();
    expect(db.requests[0].decidedAt).toBeUndefined();
  });

  it('expires the request when the member was deleted between filing and approval', async () => {
    const id = await fileRequest();
    db.users = db.users.filter((u) => String(u._id) !== MEMBER);

    await expect(svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_MEMBER);
    expect(db.requests[0].status).toBe('expired');
  });

  it('honours a bounded custom grace on approval', async () => {
    const id = await fileRequest();
    const { result } = await svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test'), graceHours: 4 });
    expect(Math.round((result.graceUntil.getTime() - Date.now()) / 3600_000)).toBe(4);
  });
});

describe('denyMfaReset — denial and withdrawal', () => {
  it('denies a pending request with a note, and records the decider', async () => {
    const id = await fileRequest();

    const view = await svc.denyMfaReset({ requestId: id, actor: actor(ADMIN_2, 'a2@acme.test'), note: 'Spoke to them' });

    expect(view).toMatchObject({ status: 'denied', decidedBy: ADMIN_2, decisionNote: 'Spoke to them' });
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('lets the REQUESTER withdraw their own request — denial needs no second person', async () => {
    const id = await fileRequest();
    const view = await svc.denyMfaReset({ requestId: id, actor: actor(ADMIN_1, 'a1@acme.test') });
    expect(view.status).toBe('denied');
    expect(view.decisionNote).toBeUndefined();
  });

  it('refuses a lapsed request (marking it expired) and a decided one', async () => {
    const lapsed = await fileRequest();
    db.requests[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.denyMfaReset({ requestId: lapsed, actor: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_EXPIRED);
    expect(db.requests[0].status).toBe('expired');

    db.requests[0].status = 'denied';
    await expect(svc.denyMfaReset({ requestId: lapsed, actor: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_PENDING);
  });

  it('answers NOT_FOUND for a malformed or unknown id', async () => {
    await expect(svc.denyMfaReset({ requestId: 'nope', actor: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
    await expect(svc.denyMfaReset({ requestId: GONE, actor: actor(ADMIN_2, 'a2@acme.test') }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
  });
});

describe('directMfaReset — the single-person sysadmin path', () => {
  it('resets immediately and supersedes any pending request for that member', async () => {
    await fileRequest();

    const result = await svc.directMfaReset({ targetUserId: MEMBER, actor: actor(SYSADMIN, 'root@pipeline-builder.test', true) });

    expect(result).toMatchObject({ userId: MEMBER, tokenVersion: 4 });
    expect(mockPublishRevocation).toHaveBeenCalledWith(MEMBER);
    // Leaving the request pending would let a second admin "approve" a reset
    // that already happened, producing a second bump and a confusing trail.
    expect(db.requests[0]).toMatchObject({ status: 'denied', decisionNote: 'Superseded by a direct reset' });
    expect(String(db.requests[0].decidedBy)).toBe(SYSADMIN);
  });

  it('REFUSES a sysadmin resetting their own factors', async () => {
    await expect(svc.directMfaReset({ targetUserId: SYSADMIN, actor: actor(SYSADMIN, 'root@pipeline-builder.test', true) }))
      .rejects.toThrow(MFA_RESET_SELF);
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND for a malformed id or a missing account', async () => {
    await expect(svc.directMfaReset({ targetUserId: 'not-an-id', actor: actor(SYSADMIN, 'root@pipeline-builder.test', true) }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
    await expect(svc.directMfaReset({ targetUserId: GONE, actor: actor(SYSADMIN, 'root@pipeline-builder.test', true) }))
      .rejects.toThrow(MFA_RESET_NOT_FOUND);
  });

  it('honours a bounded custom grace', async () => {
    const result = await svc.directMfaReset({
      targetUserId: MEMBER, actor: actor(SYSADMIN, 'root@pipeline-builder.test', true), graceHours: 200,
    });
    expect(Math.round((result.graceUntil.getTime() - Date.now()) / 3600_000)).toBe(MFA_RESET_GRACE_MAX_HOURS);
  });
});

describe('the defensive fallbacks a lost race leaves behind', () => {
  it('reports zeroes rather than NaN when a delete driver answers without a count', async () => {
    WebAuthnCredential.deleteMany.mockResolvedValueOnce({} as never);
    UserTotp.deleteOne.mockResolvedValueOnce({} as never);
    MfaRecoveryCodes.deleteOne.mockResolvedValueOnce({} as never);

    const result = await svc.resetFactors(MEMBER);

    expect(result).toMatchObject({ passkeysRemoved: 0, totpRemoved: false, recoveryCodesRemoved: false });
  });

  it('reports tokenVersion 0 when the account is deleted between the read and the bump', async () => {
    User.findByIdAndUpdate.mockImplementationOnce(() => query(() => null));
    const result = await svc.resetFactors(MEMBER);
    expect(result!.tokenVersion).toBe(0);
  });

  it('recoverMfa answers null (and audits nothing) when the account vanishes mid-reset', async () => {
    // The email lookup found them; the reset then found nothing to reset.
    User.findById.mockImplementationOnce(() => query(() => null));
    expect(await svc.recoverMfa({ email: 'member@acme.test', operator: 'ops@corp.test' })).toBeNull();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('stores an empty decider email rather than undefined when an actor carries none', async () => {
    const nameless = { id: ADMIN_1 };
    const filed = await svc.requestMfaReset({
      organizationId: ORG, targetUserId: MEMBER, requester: nameless, reason: 'r',
    });
    expect(filed.requestedByEmail).toBe('');

    const denied = await svc.denyMfaReset({ requestId: filed.id, actor: { id: ADMIN_2 } });
    expect(denied.decidedByEmail).toBeUndefined();
    expect(db.requests[0].decidedByEmail).toBe('');

    db.requests[0].status = 'pending';
    const { request } = await svc.approveMfaReset({ requestId: filed.id, approver: { id: ADMIN_2 } });
    expect(request.decidedByEmail).toBeUndefined();

    await svc.directMfaReset({ targetUserId: MEMBER, actor: { id: SYSADMIN } });
  });

  it('falls back to the claimed row when the result write cannot re-read it', async () => {
    const id = await fileRequest();
    MfaResetRequest.findByIdAndUpdate.mockImplementationOnce(() => query(() => null));

    const { request, result } = await svc.approveMfaReset({ requestId: id, approver: actor(ADMIN_2, 'a2@acme.test') });

    // The reset HAPPENED; the view just cannot show its stored result yet.
    expect(result.passkeysRemoved).toBe(2);
    expect(request.status).toBe('approved');
    expect(request.result).toBeUndefined();
  });
});
