// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route the platform service serves.
 *
 * Builds the REAL route table from `src/routes/mount.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 *
 * Platform is the identity service, so its exception list is the longest in the
 * fleet — and deliberately so. Three shapes recur:
 *
 *   1. PRE-AUTH endpoints (`/auth/*`, OAuth/SSO callbacks, invitation
 *      accept-by-token, the alert relay): they ARE the path by which a caller
 *      becomes authenticated, so what authorizes them is a credential, a signed
 *      single-use token, or a shared secret verified inside the handler.
 *   2. SELF-SERVICE `/user/*`: the caller's own profile, tokens and sessions.
 *      They act on `req.user.sub` only — there is no org permission to hold.
 *   3. DYNAMIC authorization: the decision depends on the target row or on both
 *      parties (a dashboard's own creator may write it; impersonation authority
 *      depends on the org the session pins to), so it cannot be a static route
 *      middleware and is named in each reason.
 *
 * Unlike the peer services, platform validates its declared audit actions
 * against its OWN `ALL_AUDIT_ACTIONS` union (it writes the events directly via
 * `helpers/audit.ts`), not api-core's remote-emittable subset.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations,
  type InternalRouteDeclaration,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';
import express, { type NextFunction, type Request, type Response } from 'express';

// Mounting the real routers loads the controller → service → config graph, so
// the secrets platform refuses to boot without have to be present (no Mongo
// connection is opened — the models are only declared).
process.env.JWT_SECRET ||= 'route-coverage-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../frontend/src/generated/route-table/platform.json');

/** Routes that legitimately can't satisfy a rule, each with its reason. */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,

  // -- Pre-auth public auth surface ------------------------------------------
  {
    method: 'POST',
    path: '/auth/register',
    waive: 'permission',
    reason: 'Self-service signup — the caller has no identity yet; the request is authorized by a unique email plus the password policy.',
  },
  {
    method: 'POST',
    path: '/auth/login',
    waive: 'permission',
    reason: 'Credential exchange — authorized by the submitted password itself (plus SSO enforcement); no permission can precede it.',
  },
  {
    method: 'POST',
    path: '/auth/refresh',
    waive: 'all',
    reason: 'Rotates a session on a valid REFRESH token (verified by isValidRefreshToken against the stored session slot + tokenVersion); no access token, and nothing but the slot is mutated.',
  },
  {
    method: 'POST',
    path: '/auth/token/exchange',
    waive: 'permission',
    reason: 'Credential exchange — the opaque access key in the body IS the credential, exactly as the password is on /auth/login; no permission can precede it. Rate-limited per key AND per IP, and both outcomes emit user.key.exchange[.failed].',
  },
  {
    path: /^POST \/auth\/key\/(rotate|revoke)$/,
    waive: 'permission',
    reason: 'Machine self-rotation (#N2) — the `pb_sa_…` key in the body IS the credential, exactly as on /auth/token/exchange, and no permission can precede it: an unattended rotator has no session and cannot step up, which is the whole reason these exist. Bounded instead by the SAME gates as an exchange (account enabled, org live, IP allowlist, exchange budget), the same per-key and per-IP limiters, a refusal to rotate a person\'s `pb_pat_…` key, a refusal to let a key revoke ITSELF, and org.service-account.key.rotate[.failed] on both outcomes.',
  },
  {
    path: /^POST \/auth\/device\/(code|token)$/,
    waive: 'permission',
    reason: 'Device authorization grant (RFC 8628), pre-auth by construction: /code opens a flow for a caller that HAS no identity yet, and /token is authorized by the 256-bit device code in the body exactly as /auth/token/exchange is by its key. Both rate-limited per code and per IP; the grant itself is authorized by the signed-in browser at /auth/device/approve.',
  },
  {
    path: /^(GET|POST) \/auth\/device\/(authorize|approve|deny)$/,
    waive: 'permission',
    reason: 'The caller decides whether to grant a session to THEIR OWN device — requireAuth is the whole authorization (approve adds requireStepUp); there is no org permission over one\'s own sign-in.',
  },
  {
    method: 'POST',
    path: '/auth/verify-email',
    waive: 'permission',
    reason: 'Authorized by the single-use, hash-stored, time-boxed verification token in the body — the recipient of the email is by definition not yet authenticated.',
  },
  {
    method: 'POST',
    path: '/auth/send-verification',
    waive: 'all',
    reason: 'Re-sends the verification link for the CALLER\'S OWN address (requireAuth, keyed by req.user.sub — no org permission applies), and nothing about the account changes until the link is used (POST /auth/verify-email, which is audited).',
  },
  {
    method: 'POST',
    path: '/auth/step-up/reauth',
    waive: 'audit',
    reason: 'Starts a provider re-auth and returns the redirect URL; only in-memory pending state is written. The completion (POST /auth/step-up/reauth/callback) emits user.step-up.',
  },
  {
    path: /^POST \/auth\/(webauthn\/(register|login)|step-up\/webauthn)\/options$/,
    waive: 'audit',
    reason: 'Mints a WebAuthn challenge into the short-lived ceremony store and returns it; no account state changes. Each ceremony\'s completion (/verify) emits user.passkey.register, user.login[.failed] or user.step-up.',
  },
  {
    path: /^POST \/auth\/webauthn\/login\/(options|verify)$/,
    waive: 'permission',
    reason: 'Passkey sign-in — pre-auth by construction, exactly like /auth/login: the credential IS the authorization. /options names no user at all; /verify is refused for SSO-enforced domains and returns one opaque 401 for every failure.',
  },
  {
    path: /^(GET|POST|PATCH|DELETE) \/auth\/webauthn\//,
    waive: 'permission',
    reason: 'Self-service: every passkey route acts on the CALLER\'S OWN credentials, keyed by req.user.sub. Enrolment and removal add requireStepUp + requireInteractiveSession (no API key, scoped or impersonated session); there is no org permission over one\'s own sign-in credentials.',
  },
  {
    path: /^(GET|POST|DELETE) \/auth\/totp(\/|$)/,
    waive: 'permission',
    reason: 'Self-service: every authenticator-app route acts on the CALLER\'S OWN factor, keyed by req.user.sub. Enrolment and removal add requireStepUp + requireInteractiveSession (no API key, scoped or impersonated session); there is no org permission over one\'s own sign-in credentials.',
  },
  {
    path: /^(GET|POST) \/auth\/recovery-codes$/,
    waive: 'permission',
    reason: 'Self-service: the CALLER\'S OWN recovery codes (one set per account, shared by passkeys and the authenticator app), keyed by req.user.sub. Regeneration adds requireStepUp + requireInteractiveSession; there is no org permission over one\'s own sign-in credentials.',
  },
  {
    method: 'POST',
    path: '/auth/mfa/verify',
    waive: 'permission',
    reason: 'Second leg of a password sign-in — pre-auth by construction, exactly like /auth/login: the single-use challenge handle plus the authenticator code IS the authorization. Rate-limited per challenge, bounded by a per-account lockout, and every failure returns the same opaque 401.',
  },
  {
    method: 'POST',
    path: '/auth/password/change-required',
    waive: 'permission',
    reason: 'Last leg of a password sign-in whose password no longer meets the org password policy — pre-auth by construction, like /auth/login and /auth/mfa/verify: the single-use challenge handle (issued only after the old password, and any second factor, verified) IS the authorization. Under the /auth per-IP limiter.',
  },
  {
    path: /^(GET|POST) \/auth\/(logout|switch-org|step-up|onboarding)/,
    waive: 'permission',
    reason: 'Acts on the CALLER\'S OWN session/identity (sign out, pivot active org, re-verify own password, finish own onboarding, discover + join an org matching their own verified email domain) — requireAuth is the whole authorization; there is no org permission to hold.',
  },
  {
    method: 'POST',
    path: '/auth/mark-email-verified',
    waive: 'permission',
    reason: 'Superadmin self-verify — the controller requires req.user.isSuperAdmin and only ever verifies the CALLER\'S OWN email, so it is not expressible as an org permission.',
  },
  {
    path: /^(GET|POST) \/auth\/oauth\//,
    waive: 'permission',
    reason: 'Social sign-in: provider list + authorize URL + code-for-token exchange. Pre-auth by construction; authorized by the provider-verified code and the state nonce.',
  },
  {
    path: /^(GET|POST) \/auth\/sso\//,
    waive: 'permission',
    reason: 'Per-org SSO login: discovery, the IdP authorize URL, the code + id_token callback, the SAML ACS/metadata/Single-Logout endpoints (driven by the IdP through the browser — authorized by the IdP\'s XML signature, pinned issuer and one-time state/request ids), and POST /logout, which acts only on the caller\'s OWN session (requireAuth). Pre-auth by construction; the controllers enforce "SSO enabled AND the org is sso-entitled" where a sign-in is involved.',
  },
  {
    method: 'POST',
    path: '/auth/sso/discover',
    waive: 'audit',
    reason: 'Login-page hint: answers "is this email forced through SSO?" from the org\'s IdP config. POSTed only so the email stays out of the query string; it reads and persists nothing.',
  },
  {
    method: 'POST',
    path: '/auth/sso/start',
    waive: 'audit',
    reason: 'The by-EMAIL twin of GET /:orgId/authorize — it resolves the enforcing org server-side and returns the same IdP redirect. POSTed only so the email stays out of the query string; like its by-org twin it starts a sign-in rather than completing one, and the login it leads to is audited at the callback.',
  },
  {
    method: 'GET',
    path: '/config',
    waive: 'permission',
    reason: 'Public deployment descriptor (feature flags, support aliases, deploy target, tier presets) read by the unauthenticated login/signup pages; contains no tenant data.',
  },

  // -- Self-service /user/* --------------------------------------------------
  {
    path: /^(GET|POST|PUT|PATCH|DELETE) \/user\//,
    waive: 'permission',
    reason: 'Self-service: every /user/* route acts on the caller\'s OWN identity (profile, organizations, token history, session slots, access keys, preferences, account deletion) keyed by req.user.sub. Sensitive ones add requireStepUp; there is no org permission over one\'s own account.',
  },
  {
    method: 'PUT',
    path: '/user/preferences',
    waive: 'audit',
    reason: 'Personalization only (favorites/recents for the active org) — no security-relevant state, and it is overwritten on every UI interaction.',
  },
  {
    method: 'POST',
    path: '/user/mfa-prompt/snooze',
    waive: 'audit',
    reason: 'Hides the "your account is password-only" banner for a week and nothing else — no factor, session, policy or permission changes, and the account is exactly as protected either way. Its two siblings ARE audited: the decline (user.mfa.prompt_declined) is a durable decision an admin sees the count of, and the reversal (user.mfa.prompt_restored) is what keeps that reading honest. A row a week per password-only account would bury both.',
  },

  // -- Invitations -----------------------------------------------------------
  {
    method: 'GET',
    path: '/invitation/:token',
    waive: 'permission',
    reason: 'Public preview of an invitation addressed by its unguessable token — the invitee has no account yet, which is the point of the invite.',
  },
  {
    method: 'POST',
    path: '/invitation/accept-oauth',
    waive: 'permission',
    reason: 'Accept-by-token via a social identity: authorized by the invitation token plus the provider-VERIFIED profile (never a client-supplied one); it creates the account it would otherwise need.',
  },
  {
    method: 'POST',
    path: '/invitation/accept',
    waive: 'permission',
    reason: 'The invitee accepts their OWN invitation — authorized by holding the token, not by a permission in the org they are joining (they are not a member yet).',
  },

  // -- Internal service-principal-only surfaces ------------------------------
  {
    method: 'POST',
    path: '/audit/events',
    waive: 'all',
    reason: 'INTERNAL audit ingest: requireServiceAuth verifies a peer service\'s signed token and requireInternalService names which peers may post; the action is the CALLER\'S (validated against api-core isRemoteAuditAction), so no fixed action can be declared here.',
  },
  {
    method: 'POST',
    path: '/internal/notify-email',
    waive: 'all',
    reason: 'INTERNAL service-to-service notification relay (#14: requireServiceAuth + requireInternalService({ callers: [compliance, plugin] })); it sends email/in-app notices and persists nothing of its own.',
  },
  {
    method: 'POST',
    path: '/organization/names',
    waive: 'all',
    reason: 'Internal batch id→name resolver — gated by requireServicePrincipal on the route (never reachable by a user token) and returns only id→name; nothing is written.',
  },
  {
    path: /^GET \/organization\/:id\/(parent|seat-usage|feature-entitlements)$/,
    waive: 'permission',
    reason: 'Least-privilege internal reads for peer services: the controller allows isServicePrincipal OR canAdministerOrg(targetOrg) — a two-way check on the path org that no static permission gate can express.',
  },
  {
    method: 'PUT',
    path: '/organization/:id/seat-limit',
    waive: 'permission',
    reason: 'Billing syncs the account seat/feature/tier entitlement here; the controller allows isServicePrincipal OR isSystemAdmin, and deliberately runs no step-up so the sync needs no human MFA.',
  },

  // -- Membership-scoped org reads (dynamic on the target org) ---------------
  {
    path: /^GET \/organization$/,
    waive: 'permission',
    reason: 'Reads the caller\'s OWN org, resolved from their token\'s organizationId — there is no target to authorize and no org:read permission in the catalog.',
  },
  {
    method: 'GET',
    path: '/organization/ai-config',
    waive: 'permission',
    reason: 'Own-org AI-provider STATUS (configured flag + hint only, never a key value) — deliberately readable by any member so the settings page renders read-only for them; the write is org:settings + step-up.',
  },
  {
    path: /^GET \/organization\/:id(\/(descendants|members|teams|roles))?$/,
    waive: 'permission',
    reason: 'Org profile / roster / team subtree / role list — authorization is canAccessOrg(targetOrg) in the controller: a member of that exact org, an admin of one of its ancestors, or a sysadmin. It depends on the path org, so it cannot be a static permission gate (and the catalog has no org:read/members:read).',
  },
  {
    path: /^GET \/organization\/:id\/(members\/:userId\/exists|member\/:memberId\/teams)$/,
    waive: 'permission',
    reason: 'Membership probe + per-member team annotation, same canAccessOrg(targetOrg) rule as the roster reads; the probe is also used by the message service to reject a DM to a non-member.',
  },
  {
    method: 'GET',
    path: '/audit',
    waive: 'permission',
    reason: 'requireAdminContext in the controller: a sysadmin (fleet-wide) or an org admin (scoped to their own org). Audit visibility tracks the coarse admin role by design and has no delegable permission in the catalog.',
  },

  // -- Dynamic per-row authorization ----------------------------------------
  {
    path: /^(PUT|DELETE|POST) \/dashboards\/:id(\/restore|\/purge)?$/,
    waive: 'permission',
    reason: 'dashboardService.canWrite is DYNAMIC — it also lets the dashboard\'s own CREATOR write/delete/restore/purge it, not just an org admin, so it has to resolve the target row first (restore and purge additionally require step-up).',
  },
  {
    path: /^(GET|POST) \/admin\/impersonate\/requests/,
    waive: 'permission',
    reason: 'Consent flow: the list is filtered to requests the caller opened or must decide, decide requires being the NAMED approver or a genuine tenant admin (deliberately NOT canAdministerOrg, which a sysadmin short-circuits), revoke is the off-switch, and redeem requires being the requester. All depend on the request row.',
  },
  {
    path: /^POST \/admin\/impersonate\/:userId(\/breakglass)?$/,
    waive: 'permission',
    reason: 'resolveImpersonationAuthority in the controller: a platform sysadmin (any target) or an admin of a strict ANCESTOR of the target\'s org — it depends on both parties and on the org the session pins to. Every caller is step-up gated.',
  },

  // -- SCIM 2.0 --------------------------------------------------------
  {
    path: /^(GET|POST|PUT|PATCH|DELETE) \/scim\/v2\//,
    waive: 'permission',
    reason: 'Machine provisioning surface: gated by requireScimScope — a SERVICE-ACCOUNT token carrying the `scim` capability scope (recorded on the table as the scope gate). A scoped token carries NO permissions by construction (signServiceAccountToken), so there is no permission for it to hold; the org is the token\'s own, never a path segment, and the sso entitlement is re-resolved per request.',
  },

  // -- Signed webhook + dry run ---------------------------------------------
  {
    method: 'POST',
    path: '/observability/alert-webhook',
    waive: 'all',
    reason: 'Alertmanager relay: machine-to-machine, authorized by a per-instance bearer token compared inside the handler against ALERT_WEBHOOK_INSTANCES (with the instance named in x-alertmanager-instance); it fans alerts out to destinations and persists nothing.',
  },
  {
    method: 'POST',
    path: '/admin/orgs/:orgId/kms-config/test',
    waive: 'audit',
    reason: 'Dry-run: validates a proposed CMK (an encrypt/decrypt round trip) without touching Mongo, so operators can check a key without re-prompting for step-up. The real write (PUT) emits admin.org.kms-config.upsert.',
  },
];

/**
 * The INTERNAL routes platform exposes and the services allowed to call
 * them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names, and the
 * ONE place it is written down. `findInternalRouteViolations` checks it against
 * the code in both directions.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  // compliance's notification channels + the plugin ecosystem's notices.
  { method: 'POST', path: '/internal/notify-email', callers: ['compliance', 'plugin'] },
  // Whether outbound email is on — the anonymous-submission API's precondition,
  // and the whole of the ask agent's notification diagnosis. Reading the switch
  // is strictly weaker than sending, so `ask` is here but not on the send route.
  { method: 'GET', path: '/internal/notify-email/status', callers: ['ask', 'plugin'] },
  // The plugin ecosystem's governance reads (approver count, Verified eligibility).
  { method: 'GET', path: '/internal/ecosystem/publisher-eligibility/:orgId', callers: ['plugin'] },
  { method: 'GET', path: '/internal/ecosystem/approvers', callers: ['plugin'] },
  // Every non-platform service forwards its audit trail here; platform writes
  // its own events locally and never calls this.
  {
    method: 'POST',
    path: '/audit/events',
    callers: ['ask', 'billing', 'compliance', 'image-registry', 'message',
      'pipeline', 'plugin', 'quota', 'reporting'],
  },
];

let table: RouteTableEntry[];
let allAuditActions: readonly string[];

beforeAll(async () => {
  const [{ mountApiRoutes }, { ALL_AUDIT_ACTIONS }] = await Promise.all([
    import('../src/routes/mount.js'),
    import('../src/models/audit-event.js'),
  ]);
  allAuditActions = ALL_AUDIT_ACTIONS;

  // Platform builds its app inline in index.ts (no api-server `createApp`), so
  // the table is built on a bare express app with pass-through limiters — the
  // limiters are rate control, never authorization, and none of them register a
  // route of their own.
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  const app = express();
  mountApiRoutes(app, { auth: passthrough, alertWebhook: passthrough, observability: passthrough, scim: passthrough });
  table = buildRouteTable(app);
});

describe('platform route coverage', () => {
  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions the platform audit model knows', () => {
    const unknown = declaredAuditActions(table).filter((a) => !allAuditActions.includes(a));
    expect(unknown).toEqual([]);
  });

  it('gates every internal route on requireInternalService, with the declared callers', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });

  // An assurance EXEMPTION is a conditional weakening of an `aal: 2` route, so the
  // set of routes that carry one is pinned here by name. Exactly two do, for the
  // one reason that exists: a fresh install's only administrator has no factor
  // yet, and these are the calls init-platform.sh must make to create the
  // install's automation credential (see helpers/bootstrap-admin.ts).
  it('exempts exactly the two bootstrap-setup routes from assurance, and nothing else', () => {
    const exempted = table
      .filter((e) => (e.assuranceExempt?.length ?? 0) > 0)
      .map((e) => `${e.method} ${e.path} aal${e.minAssurance}(except ${e.assuranceExempt!.join(',')})`)
      .sort();
    expect(exempted).toEqual([
      'POST /organization/:id/service-accounts aal2(except bootstrap-setup)',
      'POST /organization/:id/service-accounts/:accountId/keys aal2(except bootstrap-setup)',
    ]);
  });
});
