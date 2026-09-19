// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 enforcement engine for per-org SSO (#4).
 *
 * The second protocol behind the SAME sign-in path as OIDC
 * (`services/oidc-service.ts`): a different wire format in, the identical
 * verified identity out — `{ subject, issuer, email, name, groups }` — so the
 * checks that follow (the org's authority over the email domain, issuer-bound
 * account linking, no platform-admin sign-in, the `sso` entitlement, JIT
 * membership) are shared verbatim rather than re-implemented.
 *
 * What this module guarantees about an assertion before it returns an identity:
 *
 *   SIGNATURE   — XML-DSig over the assertion, verified by `@node-saml/node-saml`
 *                 against the org's configured IdP certificate(s). Node's own
 *                 `crypto` cannot do this (XML-DSig needs canonicalization and
 *                 reference resolution), which is why this is the one place in
 *                 the identity stack with a third-party crypto dependency. Both
 *                 the response and the assertion must be signed.
 *   ISSUER      — must equal the org's configured `samlEntityId`, so one org's
 *                 IdP can never mint an assertion accepted by another's config.
 *   AUDIENCE    — must name THIS org's SP entity id, so an assertion issued for
 *                 another service provider is refused even when the same IdP
 *                 signs both.
 *   TIME        — `NotBefore` / `NotOnOrAfter` with a small, configurable clock
 *                 skew allowance (`SAML_CLOCK_SKEW_MS`, default 60s).
 *   SP-INITIATED ONLY — a response with no `InResponseTo` is IdP-initiated and is
 *                 REFUSED. An unsolicited assertion is a login-CSRF and replay
 *                 primitive: nothing ties it to a browser that asked to sign in.
 *                 The request id is additionally checked against the id this
 *                 deployment minted (Redis-backed, consumed on use).
 *   NO REPLAY   — the assertion's own `ID` is claimed in Redis until the
 *                 assertion expires, so the same assertion can never be
 *                 presented twice, on any replica.
 *
 * Deliberately NOT here: Single Logout (SLO). It is out of scope for the first
 * release and is not half-built — there is no SLO endpoint, no `logoutUrl`
 * configuration and no `SessionIndex` bookkeeping. Signing out ends the Pipeline
 * Builder session only; see docs/authentication.md.
 */

import crypto from 'crypto';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type Profile } from '@node-saml/node-saml';
import { createLogger } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { extractGroupClaim } from '../helpers/idp-claims.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';

const logger = createLogger('saml-service');

/**
 * Typed SAML error → HTTP status map. Wired into `withController` so a failed
 * federation surfaces a correct, non-leaky status, and re-used by the ACS to
 * turn a failure into a redirect the browser can render.
 */
export const SAML_ERROR_MAP = {
  SAML_NOT_CONFIGURED: { status: 404, message: 'No SAML identity provider is configured for this organization' },
  SAML_DISABLED: { status: 403, message: 'SSO is not enabled for this organization' },
  SAML_NOT_ENTITLED: { status: 403, message: 'This organization is not entitled to SSO' },
  SAML_PROTOCOL_MISMATCH: { status: 400, message: 'This organization\'s identity provider does not use SAML' },
  SAML_INCOMPLETE_CONFIG: { status: 400, message: 'The SAML identity provider configuration is incomplete' },
  SAML_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
  SAML_IDP_INITIATED: { status: 403, message: 'Start single sign-on from Pipeline Builder — identity-provider-initiated sign-in is not accepted' },
  SAML_REPLAYED_ASSERTION: { status: 403, message: 'This single sign-on response has already been used' },
  SAML_INVALID_ASSERTION: { status: 401, message: 'The identity provider returned an invalid SAML assertion' },
  SAML_NO_EMAIL: { status: 400, message: 'The identity provider did not return an email address' },
  SAML_EMAIL_DOMAIN_NOT_ALLOWED: { status: 403, message: 'Your email domain is not permitted to sign in to this organization' },
  SAML_STEP_UP_UNSUPPORTED: { status: 400, message: 'SAML single sign-on cannot be used to confirm your identity. Use a passkey, an authenticator app, or your password.' },
} as const;

/** Every error key this module throws — the union the controllers map. */
export type SamlErrorCode = keyof typeof SAML_ERROR_MAP;

// Configuration

/** Everything the SAML login flow needs, resolved from an enabled OrgIdpConfig. */
export interface SamlLoginConfig {
  orgId: string;
  /** The IdP's `entityID`; every assertion's `Issuer` must equal it. */
  entityId: string;
  /** The IdP's SSO endpoint (HTTP-Redirect binding). */
  ssoUrl: string;
  /** Trusted IdP signing certificates. More than one during a rotation. */
  certificates: string[];
  /** Per-org attribute names for email / name / groups. */
  attributes: { email?: string; name?: string; groups?: string };
  allowedEmailDomains: string[];
}

/**
 * Where the IdP POSTs its assertion (the Assertion Consumer Service).
 *
 * `callbackBaseUrl` is the deployment's PUBLIC origin and the API is served
 * under `/api` (nginx strips the prefix before it reaches this service), so the
 * ACS an IdP must be configured with carries `/api` — unlike the OIDC
 * `redirect_uri`, which points at a frontend page.
 */
export function samlAcsUrl(orgId: string): string {
  return `${config.oauth.callbackBaseUrl}/api/auth/sso/${orgId}/saml/acs`;
}

/** This deployment's SP `entityID` for an org — also the metadata URL, which is
 *  the conventional (and self-describing) choice. Assertions must name it as
 *  their `Audience`. */
export function samlSpEntityId(orgId: string): string {
  return `${config.oauth.callbackBaseUrl}/api/auth/sso/${orgId}/saml/metadata`;
}

/** Where the ACS sends the browser once the assertion has been accepted (or
 *  refused): the frontend page that completes the sign-in. */
export function samlLandingUrl(orgId: string): string {
  return `${config.oauth.callbackBaseUrl}/auth/sso/${orgId}/saml`;
}

// Request-id cache (SP-initiated binding, shared across replicas)

/**
 * The AuthnRequest ids this deployment has minted and not yet seen come back.
 *
 * node-saml drives this through its `CacheProvider` interface; backing it with
 * the shared Redis store is what lets the `authorize` and the ACS land on
 * different replicas — exactly the reason the OIDC `state` is stored there. The
 * entry is REMOVED when the matching response arrives, so a second response
 * carrying the same `InResponseTo` finds nothing and is refused.
 */
const requestIdCache = createPendingStateStore<string>({
  prefix: 'saml:req:',
  ttlMs: config.oauth.samlRequestTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

/**
 * Assertion ids already spent, held until the assertion they name expires.
 *
 * node-saml's request-id cache already makes a straight replay fail, but only
 * for responses that carry an `InResponseTo` we minted; this is the direct
 * expression of the rule — one assertion, one sign-in — and it is what the
 * replay test asserts against.
 */
const assertionIdCache = createPendingStateStore<number>({
  prefix: 'saml:assertion:',
  ttlMs: config.oauth.samlAssertionReplayTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

/** TEST-ONLY: drop the in-memory fallbacks of both SAML caches. */
export function __resetSamlCaches(): void {
  requestIdCache._resetForTests();
  assertionIdCache._resetForTests();
}

// SAML instance

/**
 * Build the node-saml instance for an org.
 *
 * Every security-relevant option is set explicitly rather than left on a
 * default, because several of node-saml's defaults are the permissive choice:
 * `validateInResponseTo` defaults to `never` (which would accept IdP-initiated
 * responses), `acceptedClockSkewMs` to 0, and `signatureAlgorithm` to sha1.
 */
function samlFor(cfg: SamlLoginConfig): SAML {
  if (!cfg.entityId || !cfg.ssoUrl || cfg.certificates.length === 0) {
    throw new Error('SAML_INCOMPLETE_CONFIG');
  }
  return new SAML({
    // Our SP identity, and where the IdP sends the assertion.
    issuer: samlSpEntityId(cfg.orgId),
    callbackUrl: samlAcsUrl(cfg.orgId),
    audience: samlSpEntityId(cfg.orgId),
    // The IdP: its endpoint, its entity id, and the certificate(s) currently
    // trusted. An ARRAY is the rotation overlap — any of them may have signed.
    entryPoint: cfg.ssoUrl,
    idpIssuer: cfg.entityId,
    idpCert: cfg.certificates,
    // Both layers must be signed. A response-only signature leaves the assertion
    // substitutable; an assertion-only signature leaves the response status
    // forgeable.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    // SP-initiated ONLY: `always` refuses a response with no InResponseTo and
    // checks the id against one WE minted (via the Redis-backed cache below).
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: {
      async saveAsync(key: string, value: string) {
        await requestIdCache.put(key, value);
        return { value, createdAt: Date.now() };
      },
      async getAsync(key: string) {
        return requestIdCache.peek(key);
      },
      async removeAsync(key: string | null) {
        if (key) await requestIdCache.remove(key);
        return key;
      },
    },
    requestIdExpirationPeriodMs: config.oauth.samlRequestTtlMs,
    acceptedClockSkewMs: config.oauth.samlClockSkewMs,
    // Most IdPs reject the default `exact`/PasswordProtectedTransport context
    // outright; asking for no particular context is the interoperable choice and
    // costs nothing, since we never make an authorization decision from it.
    disableRequestedAuthnContext: true,
    // Don't constrain the NameID format: identity comes from the mapped
    // attributes, and pinning a format is the most common cause of a working
    // IdP refusing to issue at all.
    identifierFormat: null,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    // We do not sign AuthnRequests (there is no SP signing key to manage, and
    // the request carries nothing secret); the metadata below says so.
    generateUniqueId: () => `_${crypto.randomUUID().replace(/-/g, '')}`,
  });
}

// Public surface

/**
 * Build the SP-initiated redirect URL for an org's SAML IdP.
 *
 * `state` travels as the SAML `RelayState` and is echoed back by the IdP — it is
 * the same one-time, org-bound value the OIDC flow mints, stored in the same
 * pending-state store by the caller. The AuthnRequest id is remembered
 * separately (see {@link requestIdCache}) and is what proves the response
 * answers a request this deployment actually made.
 */
export async function buildSamlAuthorizeUrl(cfg: SamlLoginConfig, state: string): Promise<string> {
  const saml = samlFor(cfg);
  return saml.getAuthorizeUrlAsync(state, undefined, {});
}

/** The SP metadata document an IdP administrator imports. */
export function buildSamlMetadata(orgId: string): string {
  return generateServiceProviderMetadata({
    issuer: samlSpEntityId(orgId),
    callbackUrl: samlAcsUrl(orgId),
    // Matches the SAML instance above: no NameID format is requested, and
    // assertions must be signed.
    identifierFormat: null,
    wantAssertionsSigned: true,
  });
}

/** The provider-VERIFIED identity carried by an accepted assertion. Shaped
 *  exactly like `OidcIdentity` so the sign-in path is protocol-agnostic. */
export interface SamlIdentity {
  /** The assertion's `NameID` — stable per user within this IdP. */
  subject: string;
  /** The IdP's entity id. A subject is only unique together with it. */
  issuer: string;
  email: string;
  name?: string;
  /** Groups asserted by the IdP, read from the org's configured attribute.
   *  Drives JIT Role mapping (3a) only — never trusted as a permission. */
  groups: string[];
}

/** Read one attribute out of a validated profile, preferring the org's
 *  configured name and falling back to the spellings IdPs actually emit. */
function attr(profile: Profile, configured: string | undefined, fallbacks: readonly string[]): unknown {
  const bag = (profile.attributes as Record<string, unknown> | undefined) ?? {};
  const names = configured?.trim() ? [configured.trim()] : fallbacks;
  for (const name of names) {
    if (bag[name] !== undefined) return bag[name];
    if (profile[name] !== undefined) return profile[name];
  }
  return undefined;
}

/** Attribute names IdPs use for email when the org has configured none. */
const EMAIL_FALLBACKS = [
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
] as const;

/** Likewise for the display name. */
const NAME_FALLBACKS = [
  'displayName',
  'name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
] as const;

/** Likewise for group membership. */
const GROUP_FALLBACKS = [
  'groups',
  'http://schemas.xmlsoap.org/claims/Group',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
] as const;

/** First string value of an attribute that may be a string or an array. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

/**
 * Whether a base64 SAML response is a solicited (SP-initiated) one.
 *
 * Read off the raw XML BEFORE any verification, purely so an unsolicited
 * response can be refused with its own error code and audit reason instead of
 * surfacing as a generic "invalid assertion". node-saml enforces the same rule
 * authoritatively (`validateInResponseTo: always`) — this is the label, not the
 * gate, and it deliberately does not trust anything it reads here.
 */
export function isSpInitiatedResponse(samlResponseB64: string): boolean {
  let xml: string;
  try {
    xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');
  } catch {
    return false;
  }
  // Only the top-level Response element's attribute counts; a nested
  // SubjectConfirmationData InResponseTo is not what makes a response solicited.
  const open = xml.match(/<(?:[\w.-]+:)?Response\b[^>]*>/);
  if (!open) return false;
  return /\bInResponseTo\s*=\s*["'][^"']+["']/.test(open[0]);
}

/** Wall-clock bound on how long a spent assertion id is remembered. Long enough
 *  to cover any sane `NotOnOrAfter`, short enough to bound the key space. */
const MAX_REPLAY_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Claim an assertion id, or report that somebody already spent it. */
async function claimAssertionId(assertionId: string, expiresAtMs: number): Promise<boolean> {
  const ttl = Math.min(
    Math.max(expiresAtMs - Date.now(), config.oauth.samlAssertionReplayTtlMs),
    MAX_REPLAY_WINDOW_MS,
  );
  return assertionIdCache.putIfAbsent(assertionId, Date.now(), ttl);
}

/** The assertion's own id and expiry, read off the parsed assertion node-saml
 *  hands back. Both are required: an assertion with no id cannot be replay-
 *  guarded, so it is refused rather than let through unguarded. */
function assertionIdentity(profile: Profile): { id: string; expiresAtMs: number } {
  const parsed = profile.getAssertion?.() as
    | { Assertion?: { $?: { ID?: string }; Conditions?: Array<{ $?: { NotOnOrAfter?: string } }> } }
    | undefined;
  const assertion = parsed?.Assertion;
  const id = assertion?.$?.ID;
  if (!id) throw new Error('SAML_INVALID_ASSERTION');
  const notOnOrAfter = assertion?.Conditions?.[0]?.$?.NotOnOrAfter;
  const parsedExpiry = notOnOrAfter ? Date.parse(notOnOrAfter) : NaN;
  return {
    id,
    expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + config.oauth.samlAssertionReplayTtlMs,
  };
}

/**
 * Verify a posted `SAMLResponse` and return the provider-VERIFIED identity.
 *
 * This is the ONLY trustworthy source of a SAML identity — nothing the browser
 * sends alongside it is consulted. Throws typed errors from
 * {@link SAML_ERROR_MAP}; the caller maps them to a status and an audit reason.
 *
 * @param expectedState the `RelayState` the caller minted, already validated
 *   against its pending-state entry. Passed only so a mismatch is caught here
 *   too rather than relying on the controller alone.
 */
export async function validateSamlResponse(
  cfg: SamlLoginConfig,
  samlResponseB64: string,
  relayState: string | undefined,
  expectedState: string,
): Promise<SamlIdentity> {
  if (relayState !== undefined && relayState !== expectedState) throw new Error('SAML_INVALID_STATE');

  // IdP-initiated sign-in is refused before any parsing work: it is a login-CSRF
  // and replay primitive, not a supported entry point.
  if (!isSpInitiatedResponse(samlResponseB64)) throw new Error('SAML_IDP_INITIATED');

  const saml = samlFor(cfg);

  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponseB64 }));
  } catch (err) {
    logger.warn('SAML assertion verification failed', {
      orgId: cfg.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error('SAML_INVALID_ASSERTION');
  }
  if (!profile) throw new Error('SAML_INVALID_ASSERTION');

  // Issuer is checked by node-saml against `idpIssuer`; re-assert it here so the
  // identity we return can never carry an issuer we did not pin it to.
  if (profile.issuer !== cfg.entityId) throw new Error('SAML_INVALID_ASSERTION');

  // One assertion, one sign-in — claimed AFTER verification (an unverified
  // assertion must not be able to burn an id) and BEFORE any account is touched.
  const { id: assertionId, expiresAtMs } = assertionIdentity(profile);
  if (!(await claimAssertionId(assertionId, expiresAtMs))) throw new Error('SAML_REPLAYED_ASSERTION');

  const email = firstString(attr(profile, cfg.attributes.email, EMAIL_FALLBACKS))
    // A NameID that IS an email address is the common Okta/Entra shape.
    ?? (typeof profile.nameID === 'string' && profile.nameID.includes('@') ? profile.nameID : undefined);
  if (!email) throw new Error('SAML_NO_EMAIL');
  const normalizedEmail = email.trim().toLowerCase();

  // The org's pinned domain list, enforced exactly as on the OIDC path: an
  // over-broad corporate IdP must not be able to federate a foreign identity in.
  // (The stronger check — that the org has DNS-VERIFIED the domain — runs in
  // helpers/sso-enforcement on the identity this returns.)
  if (cfg.allowedEmailDomains.length > 0) {
    const domain = normalizedEmail.split('@').pop() ?? '';
    const allowed = cfg.allowedEmailDomains.map((d) => d.toLowerCase().trim().replace(/^@/, ''));
    if (!domain || !allowed.includes(domain)) throw new Error('SAML_EMAIL_DOMAIN_NOT_ALLOWED');
  }

  const subject = (typeof profile.nameID === 'string' && profile.nameID) || normalizedEmail;
  const name = firstString(attr(profile, cfg.attributes.name, NAME_FALLBACKS));

  // Groups run through the SAME normalization the OIDC groups claim does
  // (trim, case-fold, de-duplicate, cap), so a group spelled one way by a SAML
  // IdP and another by an OIDC one resolves to one mapping rule.
  const groupsAttr = attr(profile, cfg.attributes.groups, GROUP_FALLBACKS);
  const groups = extractGroupClaim({ groups: groupsAttr }, 'groups');

  return { subject, issuer: cfg.entityId, email: normalizedEmail, ...(name && { name }), groups };
}
