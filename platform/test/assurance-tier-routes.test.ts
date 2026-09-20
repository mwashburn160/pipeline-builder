// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two ASSURANCE TIERS, pinned against the REAL platform route table (the
 * one `mount.ts` builds and the frontend reads):
 *
 *   ALWAYS `aal: 2` — actions that weaken security or mint a long-lived
 *     machine credential, whatever the org's policy (`requireAssurance`).
 *   BY POLICY — administrative actions that need `aal: 2` only while the org's
 *     `adminActionsRequireMfa` is on (`requireOrgAdminAssurance`), each with
 *     its machine-credential decision.
 *
 * Loosening the MFA / impersonation policy is ALSO always-aal-2, but only in
 * one direction (tightening must stay open to an admin without MFA), so it is
 * enforced in the controllers — see `org-mfa-policy-assurance.test.ts`.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, type RouteTableEntry } from '@pipeline-builder/api-core';
import express, { type NextFunction, type Request, type Response } from 'express';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const ALWAYS_AAL2 = [
  'POST /organization/:id/service-accounts',
  'POST /organization/:id/service-accounts/:accountId/keys',
  'PATCH /organization/:id/transfer-owner',
  'PUT /users/:id',
  'PUT /users/:id/features',
  'DELETE /users/:id',
  'POST /users/bulk-delete',
  // MFA recovery: requesting, approving and a sysadmin's direct reset.
  'POST /organization/:id/mfa-resets',
  'POST /organization/:id/mfa-resets/:requestId/approve',
  'POST /admin/users/:id/mfa-reset',
];

const BY_POLICY: Record<string, 'allow' | 'refuse'> = {
  'POST /organization/:id/roles': 'allow',
  'PUT /organization/:id/roles/:roleId': 'allow',
  'DELETE /organization/:id/roles/:roleId': 'allow',
  'POST /organization/:id/roles/:roleId/members': 'allow',
  'DELETE /organization/:id/roles/:roleId/members/:userId': 'allow',
  'POST /organization/:id/idp/group-mappings': 'allow',
  'PUT /organization/:id/idp/group-mappings/:mappingId': 'allow',
  'DELETE /organization/:id/idp/group-mappings/:mappingId': 'allow',
  'POST /organization/:id/members': 'allow',
  'POST /organization/:id/members/bulk-add': 'allow',
  'DELETE /organization/:id/members/:userId': 'allow',
  'PATCH /organization/:id/members/:userId/deactivate': 'allow',
  'PATCH /organization/:id/members/:userId/activate': 'allow',
  'POST /invitation/send': 'allow',
  'DELETE /invitation/:invitationId': 'allow',
  'POST /invitation/:invitationId/resend': 'allow',
  'GET /observability/logs/export': 'allow',
  // Minting a personal credential: only a person may, while the policy is on.
  'POST /user/keys': 'refuse',
  'POST /user/generate-token': 'refuse',
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const { mountApiRoutes } = await import('../src/routes/mount.js');
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  const app = express();
  mountApiRoutes(app, { auth: passthrough, alertWebhook: passthrough, observability: passthrough, scim: passthrough });
  table = buildRouteTable(app);
});

const key = (e: RouteTableEntry) => `${e.method} ${e.path}`;

describe('assurance tiers', () => {
  it('ALWAYS requires aal 2 on the credential-minting and account-takeover routes', () => {
    for (const route of ALWAYS_AAL2) {
      const entry = table.find((e) => key(e) === route);
      expect({ route, minAssurance: entry?.minAssurance }).toEqual({ route, minAssurance: 2 });
    }
  });

  it('approving a reset, and a direct reset, need a SECOND-FACTOR step-up', () => {
    for (const route of ['POST /organization/:id/mfa-resets/:requestId/approve', 'POST /admin/users/:id/mfa-reset']) {
      const entry = table.find((e) => key(e) === route)!;
      expect({ route, stepUpMethods: entry.stepUpMethods }).toEqual({ route, stepUpMethods: ['totp', 'webauthn'] });
    }
  });

  it('denying a reset needs neither (it only removes a pending action)', () => {
    const entry = table.find((e) => key(e) === 'POST /organization/:id/mfa-resets/:requestId/deny')!;
    expect(entry.minAssurance).toBe(0);
    expect(entry.stepUp).toBe(false);
  });

  it('applies the admin-actions policy to exactly the listed routes, with their machine decision', () => {
    const gated = Object.fromEntries(
      table.filter((e) => e.orgAdminAssurance).map((e) => [key(e), e.orgAdminAssurance!.machines]),
    );
    expect(gated).toEqual(BY_POLICY);
  });

  it('never demotes a by-policy route to always-aal-2 (people without MFA keep working while the policy is off)', () => {
    for (const route of Object.keys(BY_POLICY)) {
      const entry = table.find((e) => key(e) === route)!;
      expect({ route, minAssurance: entry.minAssurance }).toEqual({ route, minAssurance: 0 });
    }
  });

  it('leaves key revocation open (the safe direction)', () => {
    for (const route of ['DELETE /user/keys/:id', 'DELETE /organization/:id/service-accounts/:accountId/keys/:keyId']) {
      const entry = table.find((e) => key(e) === route)!;
      expect({ route, minAssurance: entry.minAssurance, policy: entry.orgAdminAssurance })
        .toEqual({ route, minAssurance: 0, policy: undefined });
    }
  });
});
