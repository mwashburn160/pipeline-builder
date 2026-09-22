// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO "TEST CONNECTION" dry-run engine, shared by the test endpoints
 * (controllers/sso-test.ts) and the SAML Assertion Consumer Service
 * (controllers/saml.ts), which hands a dry-run RelayState here before any
 * sign-in logic runs.
 *
 * DRY-RUN SAFETY — a test can never become a sign-in. Four independent reasons:
 *
 *   1. SEPARATE STATE. The test `state` lives in its own pending-state store
 *      (`sso:test:`), carries a signed `ssotest.` marker, and is bound to the
 *      admin who started it. The real OIDC callback and SAML ACS consume only
 *      their own stores, so a test state is "invalid state" there.
 *   2. SEPARATE SAML REQUEST IDS. A test AuthnRequest's id goes into its own
 *      cache (services/saml-service.ts `testRequestIdCache`); the real ACS
 *      validates `InResponseTo` against the sign-in cache only, so a captured
 *      test assertion answers no request a sign-in can redeem — and the
 *      assertion id is burned by the test's own validation (replay guard).
 *   3. SEPARATE OIDC SECRETS. The test's nonce and PKCE verifier exist only in
 *      the test store; a test code posted to the real callback fails the PKCE
 *      exchange (or the nonce check, for an issuer without PKCE).
 *   4. NO SIDE EFFECTS BY CONSTRUCTION. This module never calls
 *      `findOrCreateOAuthUser`, `provisionJitMembership` or `issueTokens`; the
 *      checks it runs are the read-only halves (`assertSsoIdentityTrusted`,
 *      `assertJitSeatAvailable`, `resolveMappedRoles`).
 *
 */

import crypto from 'crypto';
import { safeEqual } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import type { z } from 'zod';
import { createPendingStateStore } from './pending-state-store.js';
import { assertSsoIdentityTrusted, type SsoIdentitySource, getTestableLoginConfig, getTestableSamlConfig } from './sso-enforcement.js';
import { config } from '../config/index.js';
import type { IdpProtocol } from '../models/org-idp-config.js';
import { SSO_SUPERADMIN_REFUSED } from '../services/auth-errors.js';
import { idpGroupMappingService } from '../services/idp-group-mapping-service.js';
import { OIDC_ERROR_MAP, exchangeAndValidate } from '../services/oidc-service.js';
import { SAML_ERROR_MAP, samlLandingUrl, validateSamlResponse } from '../services/saml-service.js';
import { getSamlSpKeys } from '../services/saml-sp-keys.js';
import { assertJitSeatAvailable } from '../services/sso-jit-service.js';
import type { ssoTestCompleteSchema } from '../utils/validation.js';

/** Prefix of every test `state` / `RelayState`. The frontend callback and SAML
 *  landing pages route on it: a test result goes back to the window that opened
 *  the popup, never into a sign-in. */
export const TEST_STATE_PREFIX = 'ssotest.';

/** A test must finish promptly. */
const TEST_TTL_MS = Math.min(config.oauth.stateTtlMs, 10 * 60_000);

export interface PendingTest {
  orgId: string;
  /** The admin who started it — the only caller allowed to collect the report. */
  actorId: string;
  protocol: IdpProtocol;
  /** The config's `updatedAt` when the test began (see recordTestResult). */
  testedUpdatedAt: string;
  /** OIDC only. */
  nonce?: string;
  codeVerifier?: string;
}

const pendingTests = createPendingStateStore<PendingTest>({
  prefix: 'sso:test:',
  ttlMs: TEST_TTL_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

/** A SAML test's report, parked by the ACS until the admin's window collects it. */
const samlTestResults = createPendingStateStore<{ pending: PendingTest; report: SsoTestReport }>({
  prefix: 'sso:testresult:',
  ttlMs: TEST_TTL_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

// Signed marker

async function markerSignature(orgId: string, nonce: string): Promise<string> {
  const { testMarkerKey } = await getSamlSpKeys();
  return crypto.createHmac('sha256', testMarkerKey).update(`${orgId}.${nonce}`).digest('base64url').slice(0, 32);
}

/** Mint `ssotest.<nonce>.<hmac(orgId.nonce)>`. */
export async function mintTestState(orgId: string): Promise<string> {
  const nonce = crypto.randomBytes(24).toString('base64url');
  return `${TEST_STATE_PREFIX}${nonce}.${await markerSignature(orgId, nonce)}`;
}

/** Whether a `state` / `RelayState` is a dry-run marker (shape only). */
export function isTestState(state: string | undefined): state is string {
  return typeof state === 'string' && state.startsWith(TEST_STATE_PREFIX);
}

/** Verify the marker's signature for `orgId` — constant-time. */
export async function verifyTestMarker(orgId: string, state: string): Promise<boolean> {
  const parts = state.slice(TEST_STATE_PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  return safeEqual(parts[1], await markerSignature(orgId, parts[0]));
}

// Report

/** What the admin sees. */
export interface SsoTestReport {
  ok: boolean;
  protocol: IdpProtocol;
  testedAt: string;
  /** Stable failure code (e.g. `invalid_assertion`, `domain_not_verified`). */
  reason?: string;
  /** Human explanation of the failure. */
  message?: string;
  /** What the IdP asserted — present whenever it got as far as a verified identity. */
  identity?: { email: string; name?: string; subject: string; issuer: string; groups: string[] };
  /** Group → Role mappings that WOULD apply at sign-in. */
  mappings?: { matchedGroups: string[]; roles: Array<{ id: string; name: string }> };
  /** Whether the result was recorded as the config's `lastTest` (false when the
   *  config changed while the test was running). */
  recorded?: boolean;
}

const MESSAGES: Record<string, string> = Object.fromEntries(
  Object.entries({ ...OIDC_ERROR_MAP, ...SAML_ERROR_MAP }).map(([code, v]) => [code, v.message]),
);

/** Stable report reason for an error code. */
function reasonOf(code: string): string {
  switch (code) {
    case 'SAML_IDP_INITIATED': return 'idp_initiated';
    case 'SAML_REPLAYED_ASSERTION': return 'replay';
    case 'SAML_INVALID_ASSERTION': return 'invalid_assertion';
    case 'SAML_ENCRYPTION_REQUIRED': return 'encryption_required';
    case 'SAML_UNEXPECTED_ENCRYPTION': return 'unexpected_encryption';
    case 'SAML_INVALID_STATE':
    case 'OIDC_INVALID_STATE': return 'invalid_state';
    case 'SAML_NO_EMAIL':
    case 'OIDC_NO_EMAIL': return 'no_email';
    case 'SAML_EMAIL_DOMAIN_NOT_ALLOWED':
    case 'OIDC_EMAIL_DOMAIN_NOT_ALLOWED': return 'email_domain_not_allowed';
    case 'OIDC_EMAIL_DOMAIN_NOT_VERIFIED': return 'domain_not_verified';
    case 'OIDC_INVALID_ID_TOKEN': return 'invalid_id_token';
    case 'OIDC_TOKEN_EXCHANGE_FAILED': return 'token_exchange_failed';
    case 'OIDC_DISCOVERY_FAILED': return 'discovery_failed';
    case 'SAML_INCOMPLETE_CONFIG': return 'incomplete_config';
    case SSO_SUPERADMIN_REFUSED: return 'platform_admin';
    case 'JIT_SEAT_LIMIT': return 'seat_limit';
    case 'IDP_ERROR': return 'idp_error';
    default: return 'error';
  }
}

function failure(protocol: IdpProtocol, err: unknown): SsoTestReport {
  const code = err instanceof Error ? err.message : 'error';
  return {
    ok: false,
    protocol,
    testedAt: new Date().toISOString(),
    reason: reasonOf(code),
    message: (Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined) ?? (code === 'IDP_ERROR'
      ? 'The identity provider returned an error instead of signing you in.'
      : 'The test could not be completed.'),
  };
}

/**
 * The read-only half of the sign-in pipeline, applied to a VERIFIED identity:
 * the org's domain authority, the platform-admin refusal and the seat
 * pre-flight — every rule that would refuse this person at a real sign-in —
 * then the group → Role mappings that would apply. Creates nothing.
 */
async function dryRunChecks(
  orgId: string,
  source: SsoIdentitySource,
  identity: { email: string; name?: string; subject: string; issuer: string; groups: string[] },
): Promise<SsoTestReport> {
  const protocol: IdpProtocol = source.protocol;
  const base = {
    protocol,
    testedAt: new Date().toISOString(),
    identity: {
      email: identity.email,
      ...(identity.name ? { name: identity.name } : {}),
      subject: identity.subject,
      issuer: identity.issuer,
      groups: identity.groups,
    },
  };
  try {
    await assertSsoIdentityTrusted(orgId, identity, source);
    const { User } = await import('../models/index.js');
    const existing = await User.findOne({ email: identity.email }).select('+isSuperAdmin').lean();
    if (existing?.isSuperAdmin === true) throw new Error(SSO_SUPERADMIN_REFUSED);
    await assertJitSeatAvailable(orgId, identity.email);
  } catch (err) {
    return { ...failure(protocol, err), ...base };
  }

  const { roleIds, matchedGroups } = await idpGroupMappingService.resolveMappedRoles(orgId, identity.groups);
  const { Role } = await import('../models/index.js');
  const roles = roleIds.length
    ? await Role.find({ _id: { $in: roleIds } }).select('_id name').lean()
    : [];
  return {
    ok: true,
    ...base,
    mappings: { matchedGroups, roles: roles.map((r) => ({ id: String(r._id), name: r.name })) },
  };
}

/** Hold a started test's state until the IdP answers. */
export async function rememberTest(state: string, pending: PendingTest): Promise<void> {
  await pendingTests.put(state, pending);
}

/**
 * Handle an assertion whose RelayState is a dry-run marker. Called by the ACS
 * BEFORE any sign-in logic; always answers with a redirect to the SAML landing
 * page carrying `?test=<state>`, which hands control back to the admin's window.
 * Never mints a handoff and never touches an account.
 */
export async function handleSamlTestAssertion(
  res: Response,
  orgId: string,
  samlResponse: string,
  relayState: string,
): Promise<void> {
  const redirect = (): void => {
    res.redirect(302, `${samlLandingUrl(orgId)}?test=${encodeURIComponent(relayState)}`);
  };

  if (!(await verifyTestMarker(orgId, relayState))) {
    res.redirect(302, `${samlLandingUrl(orgId)}?error=SAML_INVALID_STATE`);
    return;
  }
  const pending = await pendingTests.consume(relayState);
  if (!pending || pending.orgId !== orgId || pending.protocol !== 'saml') {
    res.redirect(302, `${samlLandingUrl(orgId)}?error=SAML_INVALID_STATE`);
    return;
  }

  let report: SsoTestReport;
  try {
    const cfg = await getTestableSamlConfig(orgId);
    const identity = await validateSamlResponse(cfg, samlResponse, relayState, relayState, { test: true });
    report = await dryRunChecks(orgId, { protocol: 'saml' }, identity);
  } catch (err) {
    report = failure('saml', err);
  }
  await samlTestResults.put(relayState, { pending, report });
  redirect();
}

/**
 * The report for a completed test, for the admin who started it (`actorId`),
 * or null when the state is unknown, spent, or someone else's. A SAML report was
 * parked by the ACS; an OIDC one is produced here by exchanging the code from
 * the admin's own authenticated window.
 */
export async function resolveTestReport(
  actorId: string,
  orgId: string,
  body: z.infer<typeof ssoTestCompleteSchema>,
): Promise<{ pending: PendingTest; report: SsoTestReport } | null> {

  // SAML: the ACS already ran the checks and parked the report.
  const parked = await samlTestResults.consume(body.state);
  if (parked) {
    if (parked.pending.orgId !== orgId || parked.pending.actorId !== actorId) return null;
    return parked;
  }

  // OIDC: exchange the code here, from the admin's own authenticated window.
  const pending = await pendingTests.consume(body.state);
  if (!pending || pending.orgId !== orgId || pending.actorId !== actorId || pending.protocol !== 'oidc') return null;
  if (body.error || !body.code) return { pending, report: failure('oidc', new Error('IDP_ERROR')) };
  try {
    const cfg = await getTestableLoginConfig(orgId);
    const identity = await exchangeAndValidate(cfg, body.code, pending.nonce ?? '', { codeVerifier: pending.codeVerifier });
    return { pending, report: await dryRunChecks(orgId, { protocol: 'oidc', provider: cfg.provider }, identity) };
  } catch (err) {
    return { pending, report: failure('oidc', err) };
  }
}
