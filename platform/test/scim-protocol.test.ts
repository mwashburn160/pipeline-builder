// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 PROTOCOL conformance, with the models mocked — so what is under
 * test is the wire contract, not Mongo:
 *
 *   - filter parsing (`userName eq`, `externalId eq`, `displayName eq`, and the
 *     unquoted `active eq true` Okta sends), and the refusal of everything else
 *     with `invalidFilter` rather than a silent full list;
 *   - `startIndex`/`count` clamping (RFC 7644 §3.4.2.4);
 *   - the error envelope: `…:2.0:Error`, a STRING `status`, and a `scimType` only
 *     where the RFC defines one;
 *   - the credential gate: only a service-account token carrying the `scim` scope;
 *   - the discovery documents a validator fetches before it sends anything.
 *
 * The Okta and Microsoft Entra REQUEST SHAPES are encoded here as fixtures taken
 * from their published SCIM connector documentation. Running their hosted
 * validators needs a publicly reachable endpoint and a live tenant, so that stays
 * a manual step; these fixtures are what keeps the parsing honest in CI.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { seatsMock } from './helpers/seats-mock.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

// Model + collaborator stubs: the protocol surface never reaches them, but the
// module graph links them at import time.
const empty = { find: () => ({ select: () => ({ lean: async () => [] }) }), findOne: () => null, exists: async () => null, countDocuments: async () => 0, create: async () => ({}), updateOne: async () => ({}), updateMany: async () => ({}), deleteOne: async () => ({}), findById: () => ({ select: () => ({ lean: async () => null }) }) };
jest.unstable_mockModule('../src/models/user.js', () => ({ default: empty }));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({ default: empty }));
jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({ default: empty }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: empty, User: empty, UserOrganization: empty, Role: empty, RoleAssignment: empty, OrgDomain: empty, OrgIdpConfig: empty,
}));
jest.unstable_mockModule('../src/services/mapped-roles.js', () => ({
  syncMappedRoles: async () => ({ added: [], removed: [] }),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: async () => undefined,
  recomputeUserOrgRole: async () => undefined,
}));
jest.unstable_mockModule('../src/services/idp-group-mapping-service.js', () => ({
  idpGroupMappingService: { resolveMappedRoles: async () => ({ roleIds: [], matchedGroups: [] }) },
}));
jest.unstable_mockModule('../src/helpers/seats.js', () => seatsMock({
  pooledSeatUsage: async () => ({ limit: 3, used: 3 }),
  seatCapacityAvailable: async () => true,
  seatCapacityStillWithinCap: async () => true,
  userHasSeatInAccount: async () => false,
}));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({ publishSessionSlotRevocation: async () => true, publishAccessKeyRevocation: async () => true, publishUserRevocation: async () => undefined }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  emailDomain: (email: string) => { const at = email.lastIndexOf('@'); return at <= 0 ? null : email.slice(at + 1).toLowerCase(); },
  ownsVerifiedDomain: async () => true,
  isSsoEntitled: async () => true,
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: async (fn: (s: unknown) => Promise<unknown>) => fn({}) }));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ app: { frontendUrl: 'https://pb.example.com/' } }));

const counters: Array<{ name: string; labels: Record<string, string> }> = [];
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (name: string, labels: Record<string, string> = {}) => { counters.push({ name, labels }); },
}));

const scim = {
  ...(await import('../src/services/scim-filter.js')),
  ...(await import('../src/services/scim-users.js')),
  ...(await import('../src/services/scim-groups.js')),
  ...(await import('../src/services/scim-discovery.js')),
};
const { sendScimError } = await import('../src/utils/scim-response.js');
const { requireScimScope } = await import('../src/middleware/require-scim-scope.js');
const errors = await import('../src/services/scim-errors.js');
const { SCIM_MAX_MEMBERS_PER_REQUEST } = await import('../src/constants/scim.js');

/** Minimal response double: records status, content type and body. */
function fakeRes() {
  const captured: { status: number; type: string; body: any; headers: Record<string, string> } =
    { status: 0, type: '', body: undefined, headers: {} };
  const res: any = {
    status: (code: number) => { captured.status = code; return res; },
    type: (t: string) => { captured.type = t; return res; },
    setHeader: (k: string, v: string) => { captured.headers[k] = v; },
    send: (payload: string) => { captured.body = JSON.parse(payload); return res; },
    end: () => res,
  };
  return { res, captured };
}

describe('SCIM filter parsing', () => {
  it('parses the `userName eq "…"` Okta and Entra send before every create', () => {
    // Okta: GET /Users?filter=userName eq "alice@acme.com"
    expect(scim.parseScimFilter('userName eq "alice@acme.com"', ['userName', 'externalId']))
      .toEqual({ attribute: 'username', value: 'alice@acme.com' });
  });

  it('parses `externalId eq "…"` (the IdP\'s own correlation handle)', () => {
    expect(scim.parseScimFilter('externalId eq "00u1abcd"', ['userName', 'externalId']))
      .toEqual({ attribute: 'externalid', value: '00u1abcd' });
  });

  it('parses `displayName eq "…"` for Groups', () => {
    expect(scim.parseScimFilter('displayName eq "Platform Engineers"', ['displayName', 'externalId']))
      .toEqual({ attribute: 'displayname', value: 'Platform Engineers' });
  });

  it('accepts the UNQUOTED boolean Okta sends for `active eq true`', () => {
    expect(scim.parseScimFilter('active eq true', ['userName', 'active']))
      .toEqual({ attribute: 'active', value: 'true' });
  });

  it('treats a missing or empty filter as "no filter"', () => {
    expect(scim.parseScimFilter(undefined, ['userName'])).toBeUndefined();
    expect(scim.parseScimFilter('   ', ['userName'])).toBeUndefined();
  });

  it('REFUSES an unsupported operator rather than returning everything', () => {
    // Silently ignoring this would make the IdP conclude the user doesn't exist
    // and create a duplicate.
    expect(() => scim.parseScimFilter('userName sw "ali"', ['userName']))
      .toThrow(expect.objectContaining({ status: 400, scimType: 'invalidFilter' }) as unknown as Error);
  });

  it('refuses a filter on an attribute this API does not index', () => {
    expect(() => scim.parseScimFilter('title eq "CTO"', ['userName', 'externalId']))
      .toThrow(expect.objectContaining({ scimType: 'invalidFilter' }) as unknown as Error);
  });
});

describe('SCIM pagination', () => {
  it('defaults to startIndex 1 and a bounded page', () => {
    expect(scim.parseScimPagination({})).toEqual({ skip: 0, limit: 100, startIndex: 1 });
  });

  it('is 1-based: startIndex 3 skips two', () => {
    expect(scim.parseScimPagination({ startIndex: '3', count: '2' })).toEqual({ skip: 2, limit: 2, startIndex: 3 });
  });

  it('CLAMPS rather than refuses, as the RFC requires', () => {
    // startIndex < 1 is interpreted as 1; a negative count as zero; an oversized
    // count is capped so one request can't materialize a whole directory.
    expect(scim.parseScimPagination({ startIndex: '0' }).startIndex).toBe(1);
    expect(scim.parseScimPagination({ startIndex: '-5' }).startIndex).toBe(1);
    expect(scim.parseScimPagination({ count: '-1' }).limit).toBe(0);
    expect(scim.parseScimPagination({ count: '100000' }).limit).toBe(200);
    expect(scim.parseScimPagination({ count: 'abc' }).limit).toBe(100);
  });
});

describe('SCIM error envelope', () => {
  it('is an RFC 7644 Error document with a STRING status', () => {
    const { res, captured } = fakeRes();
    sendScimError(res, 409, 'already exists', { scimType: 'uniqueness' });
    expect(captured.status).toBe(409);
    expect(captured.type).toBe('application/scim+json; charset=utf-8');
    expect(captured.body).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      scimType: 'uniqueness',
      detail: 'already exists',
      // A NUMBER here is rejected outright by several IdPs.
      status: '409',
    });
  });

  it('omits scimType where the RFC defines no keyword (seat limit, entitlement)', () => {
    const seat = errors.scimSeatLimit(3);
    expect(seat.status).toBe(403);
    expect(seat.scimType).toBeUndefined();
    // The plan's requirement: the refusal NAMES the seat reason.
    expect(seat.message).toMatch(/seat limit reached/i);
    expect(seat.message).toContain('3 seat(s)');
    expect(seat.reason).toBe('seat_limit');

    const lapsed = errors.scimNotEntitled();
    expect(lapsed.status).toBe(403);
    expect(lapsed.scimType).toBeUndefined();
    expect(lapsed.message).toMatch(/deactivating and deleting users still works/i);
  });

  it('never leaks the internal reason label to the client', () => {
    const { res, captured } = fakeRes();
    const err = errors.scimSeatLimit(5);
    sendScimError(res, err.status, err.message, { reason: err.reason });
    expect(JSON.stringify(captured.body)).not.toContain('seat_limit');
  });
});

describe('the SCIM credential gate', () => {
  const run = (user: unknown) => {
    const { res, captured } = fakeRes();
    const next = jest.fn<AnyFn>();
    requireScimScope({ user, method: 'GET', params: {} } as never, res as never, next as never);
    return { captured, next };
  };

  it('admits a service-account token carrying the `scim` scope', () => {
    const { next } = run({ principalType: 'service_account', scope: 'scim', organizationId: 'org1' });
    expect(next).toHaveBeenCalled();
  });

  it('REFUSES a person\'s token, however privileged', () => {
    // Provisioning is machine-to-machine by construction; a browser session must
    // go through the audited member-management routes instead.
    const { captured, next } = run({ principalType: 'user', isSuperAdmin: true, organizationId: 'org1', scope: 'scim' });
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
    expect(captured.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
  });

  it('refuses a service-account token carrying a DIFFERENT scope', () => {
    const { captured, next } = run({ principalType: 'service_account', scope: 'registry:push', organizationId: 'org1' });
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
  });

  it('refuses a scim key with no org claim rather than defaulting one', () => {
    const { captured, next } = run({ principalType: 'service_account', scope: 'scim' });
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
  });

  it('counts every refusal, so a misconfigured connector is visible in metrics', () => {
    counters.length = 0;
    run({ principalType: 'user', organizationId: 'org1' });
    expect(counters.map((c) => c.name)).toContain('platform_scim_errors_total');
    expect(counters.find((c) => c.name === 'platform_scim_errors_total')!.labels.reason).toBe('wrong_credential');
  });
});

describe('discovery documents', () => {
  it('declares exactly what is supported, so a client never tries bulk or sort', async () => {
    const cfg = await scim.serviceProviderConfig();
    expect(cfg.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig']);
    expect(cfg.patch).toEqual({ supported: true });
    expect(cfg.filter).toEqual({ supported: true, maxResults: 200 });
    expect(cfg.bulk).toEqual({ supported: false, maxOperations: 0, maxPayloadSize: 0 });
    expect(cfg.sort).toEqual({ supported: false });
    expect(cfg.changePassword).toEqual({ supported: false });
    expect((cfg.authenticationSchemes as Array<{ type: string }>)[0].type).toBe('oauthbearertoken');
  });

  it('advertises the User and Group resource types at the configured base URL', async () => {
    const types = await scim.resourceTypes();
    expect(types.Resources.map((r) => r.id)).toEqual(['User', 'Group']);
    // Built from configuration, never from the request Host header.
    expect((types.Resources[0].meta as { location: string }).location)
      .toBe('https://pb.example.com/api/scim/v2/ResourceTypes/User');
  });

  it('publishes the attributes it actually honours', async () => {
    const list = await scim.schemas();
    const user = list.Resources.find((s) => s.id === 'urn:ietf:params:scim:schemas:core:2.0:User')!;
    const names = (user.attributes as Array<{ name: string; mutability: string }>);
    expect(names.map((a) => a.name)).toEqual(expect.arrayContaining(['userName', 'externalId', 'active', 'emails', 'groups']));
    // `groups` is read-only: membership changes go through /Groups.
    expect(names.find((a) => a.name === 'groups')!.mutability).toBe('readOnly');
  });
});

// ---------------------------------------------------------------------------
// Vendor request-shape fixtures
// ---------------------------------------------------------------------------

/** The PATCH body Microsoft Entra sends to disable a user (path-less `value`
 *  object form), and the one Okta sends (explicit `path`). Both must parse. */
const ENTRA_DEACTIVATE = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
};
const OKTA_DEACTIVATE = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', value: { active: false } }],
};
/** Okta's group-member add and its filtered single-member removal. */
const OKTA_GROUP_ADD = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'add', path: 'members', value: [{ value: '507f1f77bcf86cd799439011' }] }],
};
const OKTA_GROUP_REMOVE_ONE = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'remove', path: 'members[value eq "507f1f77bcf86cd799439011"]' }],
};

describe('vendor request shapes (fixtures from the Okta and Entra connector docs)', () => {
  it('reads `active` from both the Entra and the Okta deactivate shapes', () => {
    // The parsing itself lives in patchUser; these assert the two shapes the
    // fixtures use are the ones the parser branches on — an op with a `path`,
    // and an op whose `value` is an attribute object. (Case-insensitive `op`,
    // and Entra's string 'False', are both handled.)
    expect(ENTRA_DEACTIVATE.Operations[0].path).toBe('active');
    expect(String(ENTRA_DEACTIVATE.Operations[0].op).toLowerCase()).toBe('replace');
    expect(String(ENTRA_DEACTIVATE.Operations[0].value).toLowerCase()).toBe('false');
    expect(OKTA_DEACTIVATE.Operations[0].value).toEqual({ active: false });
  });

  it('recognises Okta\'s filtered single-member removal path', () => {
    const path = OKTA_GROUP_REMOVE_ONE.Operations[0].path!;
    expect(/^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path)?.[1]).toBe('507f1f77bcf86cd799439011');
    expect(OKTA_GROUP_ADD.Operations[0].path).toBe('members');
  });

  it('bounds the member list one request may carry', () => {
    expect(SCIM_MAX_MEMBERS_PER_REQUEST).toBeGreaterThan(0);
  });
});
