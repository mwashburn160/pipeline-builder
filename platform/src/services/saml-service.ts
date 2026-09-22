// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 enforcement engine for per-org SSO.
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
 *   ENCRYPTION  — per-org: when the org says its IdP encrypts assertions, a
 *                 response carrying a PLAINTEXT assertion is refused (so a
 *                 downgrade can't slip one past), and the encrypted one is
 *                 decrypted with this deployment's SP encryption key; when it
 *                 doesn't, an encrypted assertion is refused.
 *
 * Beyond sign-in, this module also owns:
 *
 *   SIGNED AUTHNREQUESTS — per-org opt-in, signed with the deployment's SP
 *                 signing key (services/saml-sp-keys.ts).
 *   SINGLE LOGOUT — building the signed LogoutRequest for an SP-initiated
 *                 sign-out, verifying the IdP's LogoutRequest / LogoutResponse
 *                 (signature REQUIRED on both bindings, issuer pinned, replay
 *                 guarded), and building the signed LogoutResponse.
 *   METADATA IMPORT — parsing an IdP's metadata document into the fields the
 *                 settings form needs (entityID, SSO/SLO URLs, signing certs).
 *   DRY RUNS    — a test-connection AuthnRequest is minted into its OWN
 *                 request-id cache, so its assertion can only ever answer the
 *                 test (controllers/sso-test.ts) and never a real sign-in.
 */

import crypto from 'crypto';
import { SAML, ValidateInResponseTo, generateServiceProviderMetadata, type Profile } from '@node-saml/node-saml';
import { parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml.js';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { getSamlSpKeys } from './saml-sp-keys.js';
import { config } from '../config/index.js';
import { extractGroupClaim } from '../helpers/idp-claims.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { isReservedIssuer } from '../helpers/reserved-issuers.js';

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
  SAML_ENCRYPTION_REQUIRED: { status: 401, message: 'This organization requires encrypted SAML assertions, and the identity provider sent a plaintext one' },
  SAML_UNEXPECTED_ENCRYPTION: { status: 401, message: 'The identity provider sent an encrypted assertion, but this organization is not configured to receive encrypted assertions' },
  SAML_INVALID_LOGOUT: { status: 400, message: 'The identity provider sent an invalid single-logout message' },
  SAML_SLO_NOT_CONFIGURED: { status: 400, message: 'The identity provider has no single-logout URL configured' },
  SAML_METADATA_INVALID: { status: 400, message: 'That is not a usable SAML identity-provider metadata document: it needs one IdP entity with an entityID, an HTTP-Redirect SingleSignOnService https URL and a signing certificate' },
} as const;


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
  /** The IdP's Single Logout endpoint (HTTP-Redirect binding), when it has one. */
  sloUrl?: string;
  /** Sign AuthnRequests with the deployment's SP signing key. */
  signAuthnRequests: boolean;
  /** The IdP encrypts assertions (to the SP encryption key) — and must. */
  encryptAssertions: boolean;
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

/** This SP's Single Logout endpoint for an org — where the IdP sends its
 *  LogoutRequest (IdP-initiated) and its LogoutResponse (answering ours).
 *  Accepts both the HTTP-Redirect (GET) and HTTP-POST bindings. */
export function samlSloUrl(orgId: string): string {
  return `${config.oauth.callbackBaseUrl}/api/auth/sso/${orgId}/saml/slo`;
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

/**
 * AuthnRequest ids minted for a DRY RUN (test connection), kept apart from the
 * sign-in ids above. This separation is what makes a test assertion unusable as
 * a sign-in: the real ACS validates `InResponseTo` against {@link requestIdCache}
 * only, where a test request's id never is — and the test path validates against
 * this cache only, where a real request's id never is.
 */
const testRequestIdCache = createPendingStateStore<string>({
  prefix: 'saml:testreq:',
  ttlMs: config.oauth.samlRequestTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

/** IdP LogoutRequest ids already acted on — one LogoutRequest, one logout. */
const logoutRequestIdCache = createPendingStateStore<number>({
  prefix: 'saml:logoutreq:',
  ttlMs: config.oauth.samlAssertionReplayTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

// SAML instance

/** Which flow a node-saml instance serves — decides its request-id cache and
 *  whether its outgoing messages are signed. */
interface SamlPurpose {
  /** `login` (the real sign-in and SLO) or `test` (a dry-run connection test). */
  flow: 'login' | 'test';
  /** Sign outgoing redirect messages with the SP signing key. */
  sign: boolean;
}

/**
 * Build the node-saml instance for an org.
 *
 * Every security-relevant option is set explicitly rather than left on a
 * default, because several of node-saml's defaults are the permissive choice:
 * `validateInResponseTo` defaults to `never` (which would accept IdP-initiated
 * responses), `acceptedClockSkewMs` to 0, and `signatureAlgorithm` to sha1.
 */
async function samlFor(cfg: SamlLoginConfig, purpose: SamlPurpose): Promise<SAML> {
  if (!cfg.entityId || !cfg.ssoUrl || cfg.certificates.length === 0) {
    throw new Error('SAML_INCOMPLETE_CONFIG');
  }
  // A SAML IdP may never pose as a reserved issuer (Google): its entity id is
  // whatever the admin typed, and a reserved issuer carries domain-trust.
  if (isReservedIssuer(cfg.entityId)) throw new Error('SAML_INCOMPLETE_CONFIG');
  const keys = await getSamlSpKeys();
  const cache = purpose.flow === 'test' ? testRequestIdCache : requestIdCache;
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
    // Single logout: the IdP's SLO endpoint (falls back to nothing — SP-initiated
    // SLO is refused without it) and ours, which the IdP answers to.
    ...(cfg.sloUrl ? { logoutUrl: cfg.sloUrl } : {}),
    logoutCallbackUrl: samlSloUrl(cfg.orgId),
    // Both layers must be signed. A response-only signature leaves the assertion
    // substitutable; an assertion-only signature leaves the response status
    // forgeable.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    // SP-initiated ONLY: `always` refuses a response with no InResponseTo and
    // checks the id against one WE minted (via the Redis-backed cache below —
    // the dry-run cache for a test, the sign-in cache otherwise).
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: {
      async saveAsync(key: string, value: string) {
        await cache.put(key, value);
        return { value, createdAt: Date.now() };
      },
      async getAsync(key: string) {
        return cache.peek(key);
      },
      async removeAsync(key: string | null) {
        if (key) await cache.remove(key);
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
    // Outgoing redirect messages are signed (SigAlg + Signature query params)
    // exactly when a private key is configured: AuthnRequests per the org's
    // opt-in, logout messages always.
    ...(purpose.sign ? { privateKey: keys.signing.privateKey, publicCert: keys.signing.certificate } : {}),
    // Only an org that has said its IdP encrypts gets a decryption key; without
    // one node-saml refuses an EncryptedAssertion outright.
    ...(cfg.encryptAssertions ? { decryptionPvk: keys.encryption.privateKey } : {}),
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
export async function buildSamlAuthorizeUrl(
  cfg: SamlLoginConfig,
  state: string,
  opts: { test?: boolean } = {},
): Promise<string> {
  const saml = await samlFor(cfg, { flow: opts.test ? 'test' : 'login', sign: cfg.signAuthnRequests });
  return saml.getAuthorizeUrlAsync(state, undefined, {});
}

/** The per-org options the SP metadata reflects. */
export interface SamlMetadataOptions {
  signAuthnRequests: boolean;
  encryptAssertions: boolean;
}

/**
 * The SP metadata document an IdP administrator imports.
 *
 * Always publishes the SIGNING certificate (the IdP needs it to verify our
 * LogoutRequests/Responses, and to verify AuthnRequests when the org signs them)
 * and both Single Logout bindings. `AuthnRequestsSigned` states the org's actual
 * choice. The ENCRYPTION certificate is published only when the org has turned
 * encrypted assertions on: several IdPs (Shibboleth, and Okta/Entra when told
 * to) start encrypting the moment the metadata offers a key, and an assertion
 * encrypted to an org that isn't expecting one is refused.
 */
export async function buildSamlMetadata(orgId: string, opts: SamlMetadataOptions): Promise<string> {
  const keys = await getSamlSpKeys();
  let xml = generateServiceProviderMetadata({
    issuer: samlSpEntityId(orgId),
    callbackUrl: samlAcsUrl(orgId),
    logoutCallbackUrl: samlSloUrl(orgId),
    // Matches the SAML instance above: no NameID format is requested, and
    // assertions must be signed.
    identifierFormat: null,
    wantAssertionsSigned: true,
    privateKey: keys.signing.privateKey,
    publicCerts: keys.signing.certificate,
    signatureAlgorithm: 'sha256',
    ...(opts.encryptAssertions
      ? { decryptionPvk: keys.encryption.privateKey, decryptionCert: keys.encryption.certificate }
      : {}),
  });
  // node-saml derives AuthnRequestsSigned from "a signing key is present"; ours
  // is always present (logout), so state the org's real choice instead.
  if (!opts.signAuthnRequests) {
    xml = xml.replace(/AuthnRequestsSigned="true"/, 'AuthnRequestsSigned="false"');
  }
  // node-saml only advertises the HTTP-POST SLO binding; our endpoint takes the
  // HTTP-Redirect binding too, which is what most IdPs prefer.
  xml = xml.replace(
    /(<SingleLogoutService [^>]*\/>)/,
    `$1<SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${samlSloUrl(orgId)}"/>`,
  );
  return xml;
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
   *  Drives JIT Role mapping only — never trusted as a permission. */
  groups: string[];
  /** The IdP's handle on this sign-in, kept for Single Logout. */
  session: SamlSessionRef;
}

/** What a LogoutRequest must name for the IdP to find ITS session. */
export interface SamlSessionRef {
  nameID: string;
  nameIDFormat?: string;
  sessionIndex?: string;
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

/** Minimal structural view of an xmldom element (the platform compiles without
 *  the DOM lib, so node-saml's `Element` type is not available by name). */
interface XmlElement {
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/** Decode a base64 SAML message and parse it; null when it isn't XML. */
async function parseSamlXml(b64: string): Promise<unknown | null> {
  try {
    return await parseDomFromString(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Enforce the org's encryption choice on the RAW response, before verification.
 *
 * This is the gate (unlike {@link isSpInitiatedResponse}, which is only a label):
 * node-saml happily accepts a plaintext assertion even when it holds a
 * decryption key, so without this check an attacker able to obtain any signed
 * plaintext assertion could present it to an org that requires encryption. The
 * count is over EVERY element named `Assertion` anywhere in the document — an
 * encrypted assertion's plaintext never appears in the raw XML, so any such
 * element is a plaintext one.
 */
async function assertEncryptionShape(cfg: SamlLoginConfig, samlResponseB64: string): Promise<void> {
  const dom = await parseSamlXml(samlResponseB64);
  if (!dom) throw new Error('SAML_INVALID_ASSERTION');
  const plain = xpath.selectElements(dom as never, "//*[local-name()='Assertion']").length;
  const encrypted = xpath.selectElements(dom as never, "//*[local-name()='EncryptedAssertion']").length;
  if (cfg.encryptAssertions) {
    if (plain > 0 || encrypted === 0) throw new Error('SAML_ENCRYPTION_REQUIRED');
  } else if (encrypted > 0) {
    throw new Error('SAML_UNEXPECTED_ENCRYPTION');
  }
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
  opts: { test?: boolean } = {},
): Promise<SamlIdentity> {
  if (relayState !== undefined && relayState !== expectedState) throw new Error('SAML_INVALID_STATE');

  // IdP-initiated sign-in is refused before any parsing work: it is a login-CSRF
  // and replay primitive, not a supported entry point.
  if (!isSpInitiatedResponse(samlResponseB64)) throw new Error('SAML_IDP_INITIATED');

  await assertEncryptionShape(cfg, samlResponseB64);

  // A dry run validates against the TEST request-id cache — see
  // `testRequestIdCache` for why the two never mix.
  const saml = await samlFor(cfg, { flow: opts.test ? 'test' : 'login', sign: false });

  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponseB64 }));
  } catch (err) {
    logger.warn('SAML assertion verification failed', {
      orgId: cfg.orgId,
      error: errorMessage(err),
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

  return {
    subject,
    issuer: cfg.entityId,
    email: normalizedEmail,
    ...(name && { name }),
    groups,
    session: {
      nameID: typeof profile.nameID === 'string' && profile.nameID ? profile.nameID : normalizedEmail,
      ...(profile.nameIDFormat ? { nameIDFormat: profile.nameIDFormat } : {}),
      ...(profile.sessionIndex ? { sessionIndex: profile.sessionIndex } : {}),
    },
  };
}

// Single Logout

/**
 * Build the SP-initiated LogoutRequest redirect for a SAML session — ALWAYS
 * signed with the SP signing key (IdPs generally refuse unsigned logout
 * messages). The request id is remembered in the sign-in request-id cache, so
 * the IdP's LogoutResponse must answer it.
 */
export async function buildSamlLogoutRequestUrl(
  cfg: SamlLoginConfig,
  session: SamlSessionRef,
  relayState: string,
): Promise<string> {
  if (!cfg.sloUrl) throw new Error('SAML_SLO_NOT_CONFIGURED');
  const saml = await samlFor(cfg, { flow: 'login', sign: true });
  return saml.getLogoutUrlAsync({
    issuer: cfg.entityId,
    nameID: session.nameID,
    nameIDFormat: session.nameIDFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    ...(session.sessionIndex ? { sessionIndex: session.sessionIndex } : {}),
  } as Profile, relayState, {});
}

/** A verified message received at the SLO endpoint. */
export type SamlLogoutMessage =
  | { kind: 'request'; id: string; session: SamlSessionRef }
  | { kind: 'response' };

/** How the message arrived: the HTTP-Redirect binding carries its signature in
 *  the query string (`SigAlg` + `Signature`), the HTTP-POST binding inside the
 *  XML. */
export type SamlLogoutBinding =
  | { binding: 'redirect'; query: Record<string, string>; rawQuery: string }
  | { binding: 'post'; body: Record<string, string> };

/**
 * Verify a LogoutRequest (IdP-initiated) or LogoutResponse (answering ours)
 * received at the SLO endpoint. Throws `SAML_INVALID_LOGOUT` on any failure.
 *
 * On top of node-saml's checks (issuer pinned to the org's IdP, validity window,
 * signature against the trusted certificates) this REQUIRES a signature on the
 * redirect binding — node-saml would accept an unsigned one — and refuses a
 * replayed LogoutRequest id, so one captured request can't be used to sign the
 * same person out over and over. A LogoutResponse must answer a LogoutRequest
 * this deployment sent (its `InResponseTo`, consumed on use).
 */
export async function validateSamlLogoutMessage(
  cfg: SamlLoginConfig,
  message: SamlLogoutBinding,
): Promise<SamlLogoutMessage> {
  const saml = await samlFor(cfg, { flow: 'login', sign: false });
  try {
    if (message.binding === 'redirect') {
      if (!message.query.Signature || !message.query.SigAlg) throw new Error('unsigned redirect-binding logout message');
      if (message.query.SAMLResponse) {
        // verifyLogoutResponse inside checks status, issuer and InResponseTo.
        const inResponseTo = await logoutResponseInResponseTo(message.query.SAMLResponse, 'redirect');
        await saml.validateRedirectAsync(message.query, message.rawQuery);
        await requestIdCache.remove(inResponseTo);
        return { kind: 'response' };
      }
      if (!message.query.SAMLRequest) throw new Error('no SAML message');
      const { profile } = await saml.validateRedirectAsync(message.query, message.rawQuery);
      return await claimLogoutRequest(profile);
    }
    if (message.body.SAMLResponse) {
      const inResponseTo = await logoutResponseInResponseTo(message.body.SAMLResponse, 'post');
      if (!(await requestIdCache.peek(inResponseTo))) throw new Error('LogoutResponse answers no request we sent');
      const { loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: message.body.SAMLResponse });
      if (!loggedOut) throw new Error('not a LogoutResponse');
      await requestIdCache.remove(inResponseTo);
      return { kind: 'response' };
    }
    if (!message.body.SAMLRequest) throw new Error('no SAML message');
    const { profile } = await saml.validatePostRequestAsync({ SAMLRequest: message.body.SAMLRequest });
    return await claimLogoutRequest(profile);
  } catch (err) {
    logger.warn('SAML logout message refused', { orgId: cfg.orgId, error: errorMessage(err) });
    throw new Error('SAML_INVALID_LOGOUT');
  }
}

/** The `InResponseTo` of a LogoutResponse, required to be present. The binding
 *  decides the encoding: HTTP-Redirect carries the XML DEFLATE-compressed
 *  before base64 (SAML 2.0 bindings §3.4.4.1), HTTP-POST base64 only. Named by
 *  binding rather than by a bare `deflated` flag so the call sites read as the
 *  binding they are already branching on. */
async function logoutResponseInResponseTo(b64: string, binding: SamlLogoutBinding['binding']): Promise<string> {
  const { inflateRawSync } = await import('zlib');
  const xml = binding === 'redirect'
    ? inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8')
    : Buffer.from(b64, 'base64').toString('utf8');
  const dom = await parseDomFromString(xml);
  const root = (dom as unknown as { documentElement?: XmlElement & { localName?: string } }).documentElement;
  if (!root || root.localName !== 'LogoutResponse') throw new Error('not a LogoutResponse');
  const inResponseTo = root.getAttribute('InResponseTo');
  if (!inResponseTo) throw new Error('LogoutResponse has no InResponseTo');
  return inResponseTo;
}

/** Claim a verified LogoutRequest's id (replay guard) and project it. */
async function claimLogoutRequest(profile: Profile | null): Promise<SamlLogoutMessage> {
  const p = profile as (Profile & { ID?: string }) | null;
  if (!p?.ID || !p.nameID) throw new Error('LogoutRequest missing ID or NameID');
  if (!(await logoutRequestIdCache.putIfAbsent(p.ID, Date.now()))) throw new Error('replayed LogoutRequest');
  return {
    kind: 'request',
    id: p.ID,
    session: {
      nameID: p.nameID,
      ...(p.nameIDFormat ? { nameIDFormat: p.nameIDFormat } : {}),
      ...(p.sessionIndex ? { sessionIndex: p.sessionIndex } : {}),
    },
  };
}

/**
 * Build the signed LogoutResponse redirect answering an IdP LogoutRequest.
 * `success: false` reports `Requester/UnknownPrincipal`.
 */
export async function buildSamlLogoutResponseUrl(
  cfg: SamlLoginConfig,
  requestId: string,
  success: boolean,
  relayState: string | undefined,
): Promise<string> {
  if (!cfg.sloUrl) throw new Error('SAML_SLO_NOT_CONFIGURED');
  const saml = await samlFor(cfg, { flow: 'login', sign: true });
  return saml.getLogoutResponseUrlAsync({ ID: requestId } as unknown as Profile, relayState ?? '', {}, success);
}

// IdP metadata import

/** What the settings form needs from an IdP's metadata document. */
export interface ParsedIdpMetadata {
  entityId: string;
  /** HTTP-Redirect SingleSignOnService location. */
  ssoUrl: string;
  /** HTTP-Redirect SingleLogoutService location, when the IdP offers one. */
  sloUrl?: string;
  /** Signing certificates (PEM), at most three — the trust-list cap. */
  certificates: string[];
  /** Whether the IdP asks for signed AuthnRequests (`WantAuthnRequestsSigned`). */
  wantsSignedRequests: boolean;
}

const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** Wrap a bare base64 certificate as PEM. */
function toPem(base64: string): string {
  const body = base64.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

/**
 * Parse an IdP metadata document (an `EntityDescriptor`, or an
 * `EntitiesDescriptor` holding exactly one IdP) into form fields. Throws
 * `SAML_METADATA_INVALID` with no detail — the caller shows a generic message.
 *
 * Parsing is done with node-saml's own hardened parser (xmldom, no external
 * entity resolution); nothing in the document is trusted beyond being copied
 * into a form the administrator then reviews and saves under step-up.
 */
export async function parseIdpMetadata(xmlText: string): Promise<ParsedIdpMetadata> {
  let dom: unknown;
  try {
    dom = await parseDomFromString(xmlText);
  } catch {
    throw new Error('SAML_METADATA_INVALID');
  }
  const select = (node: unknown, path: string): XmlElement[] => xpath.selectElements(node as never, path) as unknown as XmlElement[];

  const idpDescriptors = select(dom, "//*[local-name()='IDPSSODescriptor']");
  if (idpDescriptors.length !== 1) throw new Error('SAML_METADATA_INVALID');
  const entities = select(dom, "//*[local-name()='EntityDescriptor'][*[local-name()='IDPSSODescriptor']]");
  const entityId = entities[0]?.getAttribute('entityID')?.trim();
  if (!entityId) throw new Error('SAML_METADATA_INVALID');

  const idp = idpDescriptors[0];
  const endpoint = (element: string): string | undefined => {
    const nodes = select(idp, `./*[local-name()='${element}']`);
    const redirect = nodes.find((n) => n.getAttribute('Binding') === REDIRECT_BINDING);
    const location = redirect?.getAttribute('Location')?.trim();
    return location && location.startsWith('https://') ? location : undefined;
  };
  const ssoUrl = endpoint('SingleSignOnService');
  if (!ssoUrl) throw new Error('SAML_METADATA_INVALID');
  const sloUrl = endpoint('SingleLogoutService');

  // Signing certificates: KeyDescriptors with use="signing" or no `use` at all
  // (which means "both"); encryption-only keys are not trust anchors.
  const keyDescriptors = select(idp, "./*[local-name()='KeyDescriptor']")
    .filter((k) => { const use = k.getAttribute('use'); return !use || use === 'signing'; });
  const seen = new Set<string>();
  const certificates: string[] = [];
  for (const kd of keyDescriptors) {
    for (const certNode of select(kd, ".//*[local-name()='X509Certificate']")) {
      const b64 = (certNode.textContent ?? '').replace(/\s+/g, '');
      if (!b64 || seen.has(b64)) continue;
      seen.add(b64);
      certificates.push(toPem(b64));
    }
  }
  if (certificates.length === 0) throw new Error('SAML_METADATA_INVALID');

  return {
    entityId,
    ssoUrl,
    ...(sloUrl ? { sloUrl } : {}),
    certificates: certificates.slice(0, 3),
    wantsSignedRequests: idp.getAttribute('WantAuthnRequestsSigned') === 'true',
  };
}
