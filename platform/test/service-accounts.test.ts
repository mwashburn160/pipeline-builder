// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Service-account rules that need no database (#2):
 *   - the IP allowlist matcher (exact, CIDR, v4-mapped-v6, and the fail-closed
 *     "allowlist set but no presenting address" case);
 *   - the seat/quota contract: a service account takes NO seat and carries its
 *     OWN token-exchange budget — asserted against the seat helper's query shape
 *     and the model's own defaults, so a future change to either is caught here;
 *   - a service-account token never satisfies step-up (api-core's gate), which is
 *     what "machine credentials never satisfy assurance requirements" means in
 *     practice;
 *   - the `service_accounts:manage` permission is a real, org-assignable
 *     capability in the shared catalog and is NOT in the member bundle.
 *
 * The lifecycle itself (create → key → exchange → revoke → cascade) is covered
 * against real Mongo in `service-accounts.integration.test.ts`.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  ALL_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  ROLE_PERMISSIONS,
  isValidPermission,
  requireStepUp,
} from '@pipeline-builder/api-core';

// Importing the service pulls in platform's config module, which refuses to
// load without these (no connection is opened — only the models are declared).
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { ipAllowed, MAX_ACTIVE_KEYS_PER_ACCOUNT, MAX_KEY_EXPIRES_IN_SECONDS } =
  await import('../src/services/service-account-service.js');

describe('service-account key IP allowlist', () => {
  it('allows anything when no allowlist is set', () => {
    expect(ipAllowed(undefined, '203.0.113.7')).toBe(true);
    expect(ipAllowed([], '203.0.113.7')).toBe(true);
    expect(ipAllowed(null, undefined)).toBe(true);
  });

  it('matches exact addresses and CIDR blocks, in both families', () => {
    expect(ipAllowed(['203.0.113.7'], '203.0.113.7')).toBe(true);
    expect(ipAllowed(['203.0.113.7'], '203.0.113.8')).toBe(false);
    expect(ipAllowed(['203.0.113.0/24'], '203.0.113.200')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '198.51.100.1')).toBe(false);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:dbf::1')).toBe(false);
  });

  it('normalizes the IPv4-mapped IPv6 form Express reports on a dual-stack socket', () => {
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.7')).toBe(true);
  });

  it('DENIES when an allowlist is set but the presenting address is unknown or unparseable', () => {
    // The control exists to bind a key to known addresses — "we couldn't tell"
    // must never pass it.
    expect(ipAllowed(['203.0.113.0/24'], undefined)).toBe(false);
    expect(ipAllowed(['203.0.113.0/24'], 'not-an-ip')).toBe(false);
  });
});

describe('service-account key limits', () => {
  it('caps active keys at five and lifetimes at 365 days', () => {
    expect(MAX_ACTIVE_KEYS_PER_ACCOUNT).toBe(5);
    expect(MAX_KEY_EXPIRES_IN_SECONDS).toBe(365 * 24 * 60 * 60);
  });
});

describe('key capability scopes (#12)', () => {
  it('offers exactly the scopes the consuming routes enforce', async () => {
    const { TOKEN_SCOPES } = await import('@pipeline-builder/api-core');
    // One closed catalog, shared by every mint path. `reporting:ingest` gates the
    // reporting machine writes and `registry:push` the image-registry `/token`
    // push grant; anything not enforced somewhere has no business being mintable.
    expect(TOKEN_SCOPES).toEqual(expect.arrayContaining(['reporting:ingest', 'registry:push']));
  });

  it('validates a key scope against that catalog, refusing anything else', async () => {
    const { createServiceAccountKeySchema } = await import('../src/utils/validation.js');
    const base = { name: 'k', expiresIn: 86400 };
    expect(createServiceAccountKeySchema.safeParse({ ...base, scope: 'registry:push' }).success).toBe(true);
    expect(createServiceAccountKeySchema.safeParse({ ...base, scope: 'reporting:ingest' }).success).toBe(true);
    // Unscoped stays valid — that is the key that carries the account's roles.
    expect(createServiceAccountKeySchema.safeParse(base).success).toBe(true);
    // A plausible-looking typo must be a 400, never a silently unenforced credential.
    expect(createServiceAccountKeySchema.safeParse({ ...base, scope: 'registry:pushh' }).success).toBe(false);
    expect(createServiceAccountKeySchema.safeParse({ ...base, scope: '*' }).success).toBe(false);
  });
});

describe('seats and quota', () => {
  it('counts seats from MEMBERSHIPS only, so a service account can never consume one', async () => {
    // Seat usage is the distinct-active-human count over `UserOrganization`
    // plus live invitations. A service account writes neither collection, so
    // "takes no seat" is structural — pinned here by asserting the two
    // collections the helper actually reads.
    const source = (await import('node:fs')).readFileSync(
      new URL('../src/helpers/seats.ts', import.meta.url), 'utf8',
    );
    expect(source).toContain("UserOrganization.distinct('userId'");
    expect(source).toContain("Invitation.distinct('email'");
    expect(source).not.toContain('ServiceAccount');
  });

  it('gives every account its own exchange budget, defaulting to unlimited', async () => {
    const { default: ServiceAccount } = await import('../src/models/service-account.js');
    const paths = ServiceAccount.schema.paths as Record<string, { defaultValue?: unknown }>;
    expect(paths.tokenBudget.defaultValue).toBe(-1);
    // Usage is tracked ON THE ACCOUNT — not on the org's quota document, which
    // is what "a service account has its OWN quota" has to mean for it to bound
    // anything.
    expect(Object.keys(paths)).toEqual(expect.arrayContaining(['usage.exchanges', 'usage.resetAt']));
  });
});

describe('assurance', () => {
  it('refuses step-up for a service-account principal', async () => {
    const res: Record<string, unknown> = {};
    let status = 0;
    let body: { code?: string } = {};
    res.status = (s: number) => { status = s; return res; };
    res.json = (b: { code?: string }) => { body = b; return res; };
    const next = jest.fn();

    await requireStepUp(
      { user: { principalType: 'service_account', sub: 'sa-1' }, headers: {} } as never,
      res as never,
      next as never,
    );

    expect(next).not.toHaveBeenCalled();
    expect(status).toBe(403);
    expect(body.code).toBe('STEP_UP_NOT_AVAILABLE');
  });
});

describe('the service_accounts:manage permission', () => {
  it('is a real, org-assignable capability that members do not hold', () => {
    expect(isValidPermission('service_accounts:manage')).toBe(true);
    expect(ALL_PERMISSIONS).toContain('service_accounts:manage');
    expect(ORG_ASSIGNABLE_PERMISSIONS).toContain('service_accounts:manage');
    // Admins hold it (the whole org-assignable bundle); plain members must not —
    // minting machine credentials is an administrative act.
    expect(ROLE_PERMISSIONS.admin).toContain('service_accounts:manage');
    expect(ROLE_PERMISSIONS.member).not.toContain('service_accounts:manage');
  });
});
