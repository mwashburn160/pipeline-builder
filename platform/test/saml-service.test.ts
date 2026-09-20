// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 assertion verification (#4, services/saml-service.ts).
 *
 * Every case here signs REAL XML with a throwaway key (test/helpers/saml-fixture)
 * and runs it through the production verifier, so a signature, audience, issuer
 * or validity-window failure is a genuine XML-DSig outcome rather than a mocked
 * boolean. Covered:
 *   - a valid assertion → the verified identity (subject, issuer, email, name,
 *     groups through the org's attribute mapping);
 *   - wrong audience, expired, not-yet-valid, bad signature, wrong issuer;
 *   - replay: the same assertion presented twice;
 *   - IdP-initiated (no InResponseTo) refused before any parsing;
 *   - certificate ROTATION OVERLAP: a trust list holding the new and the old
 *     certificate accepts assertions signed by either;
 *   - SIGNED AuthnRequests (per-org opt-in) and SP metadata publishing the SP
 *     keys + both SLO bindings;
 *   - ENCRYPTED assertions: decrypted when required, a plaintext one refused
 *     when encryption is required, an encrypted one refused when it isn't;
 *   - SINGLE LOGOUT: our signed LogoutRequest, the IdP's LogoutRequest on both
 *     bindings (unsigned / wrong key / replay refused), its LogoutResponse;
 *   - IdP METADATA import parsing;
 *   - DRY-RUN isolation: a test AuthnRequest's assertion can't answer a
 *     sign-in, and vice versa.
 *
 * The roadmap also asks for a live Keycloak run; that stays a manual exercise
 * (see the fixture module's header for why it isn't the CI gate).
 */

import zlib from 'zlib';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import {
  buildEncryptedSamlResponse,
  buildPostLogoutRequest,
  buildRedirectLogoutRequest,
  buildRedirectLogoutResponse,
  buildSamlResponse,
  generateIdpKeyPair,
  generateSpKeys,
  requestIdFromAuthorizeUrl,
  requestIdFromLogoutUrl,
  type IdpKeyPair,
} from './helpers/saml-fixture.js';

const SP_KEYS = generateSpKeys();
jest.unstable_mockModule('../src/services/saml-sp-keys.js', () => ({
  getSamlSpKeys: async () => SP_KEYS,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    oauth: {
      callbackBaseUrl: 'https://pb.test',
      cleanupIntervalMs: 600_000,
      maxPendingStates: 1000,
      samlClockSkewMs: 60_000,
      samlRequestTtlMs: 600_000,
      samlAssertionReplayTtlMs: 600_000,
      samlHandoffTtlMs: 120_000,
    },
  },
}));

// Force the pending-state store's in-memory fallback (Redis unset), so the
// request-id and replay caches round-trip within the process.
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => undefined),
}));

const {
  __resetSamlCaches,
  buildSamlAuthorizeUrl,
  buildSamlLogoutRequestUrl,
  buildSamlLogoutResponseUrl,
  buildSamlMetadata,
  isSpInitiatedResponse,
  parseIdpMetadata,
  samlAcsUrl,
  samlSloUrl,
  samlSpEntityId,
  validateSamlLogoutMessage,
  validateSamlResponse,
} = await import('../src/services/saml-service.js');

const ORG = 'org-saml-1';
const IDP_ENTITY = 'https://idp.test/saml/metadata';
const SP_ENTITY = `https://pb.test/api/auth/sso/${ORG}/saml/metadata`;
const ACS = `https://pb.test/api/auth/sso/${ORG}/saml/acs`;
const SLO = `https://pb.test/api/auth/sso/${ORG}/saml/slo`;
const IDP_SLO = 'https://idp.test/slo/saml';

let keys: IdpKeyPair;

function cfg(overrides: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) {
  return {
    orgId: ORG,
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.test/sso/saml',
    certificates: [keys.certificate],
    attributes: {},
    allowedEmailDomains: [],
    signAuthnRequests: false,
    encryptAssertions: false,
    ...overrides,
  };
}

/**
 * Start a real SP-initiated flow and return the AuthnRequest id it minted.
 *
 * The login path accepts a response only if its `InResponseTo` names a request
 * this deployment actually made — so every positive case here goes through the
 * initiate leg first, which is also what proves that binding is load-bearing.
 * The id is CONSUMED by a successful validation, so a test that validates twice
 * mints twice.
 */
async function mintRequestId(): Promise<string> {
  return requestIdFromAuthorizeUrl(await buildSamlAuthorizeUrl(cfg(), 'state-1'));
}

/** A well-formed, solicited response — the baseline every negative case bends. */
function goodResponse(over: Partial<Parameters<typeof buildSamlResponse>[1]> = {}, withKeys = keys): string {
  return buildSamlResponse(withKeys, {
    issuer: IDP_ENTITY,
    audience: SP_ENTITY,
    destination: ACS,
    nameId: 'ada@acme.test',
    attributes: { email: 'Ada@Acme.test', displayName: 'Ada Lovelace', groups: ['Engineering', 'Admins'] },
    ...over,
  });
}

/** `goodResponse` bound to a freshly minted, answerable request id. */
async function solicited(over: Partial<Parameters<typeof buildSamlResponse>[1]> = {}, withKeys = keys): Promise<string> {
  return goodResponse({ inResponseTo: await mintRequestId(), ...over }, withKeys);
}

beforeEach(() => {
  keys = generateIdpKeyPair();
  __resetSamlCaches();
});

describe('service-provider identity', () => {
  it('derives the SP entity id and ACS url from the org and the public base url', () => {
    expect(samlSpEntityId(ORG)).toBe(SP_ENTITY);
    // The API lives under /api (nginx strips the prefix before this service),
    // so the ACS an IdP must be told about carries it.
    expect(samlAcsUrl(ORG)).toBe(ACS);
  });

  it('publishes SP metadata naming the ACS with the HTTP-POST binding', async () => {
    const xml = await buildSamlMetadata(ORG, { signAuthnRequests: false, encryptAssertions: false });
    expect(xml).toContain(`entityID="${SP_ENTITY}"`);
    expect(xml).toContain(ACS);
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  });

  it('publishes the SLO endpoint on both bindings and the signing certificate', async () => {
    const xml = await buildSamlMetadata(ORG, { signAuthnRequests: false, encryptAssertions: false });
    expect(samlSloUrl(ORG)).toBe(SLO);
    expect(xml).toMatch(new RegExp(`SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${SLO}"`));
    expect(xml).toMatch(new RegExp(`SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SLO}"`));
    expect(xml).toContain('use="signing"');
    // AuthnRequestsSigned states the org's real choice, not "a key exists".
    expect(xml).toContain('AuthnRequestsSigned="false"');
    // No encryption key is offered to an org that hasn't asked for encryption —
    // several IdPs start encrypting the moment one is published.
    expect(xml).not.toContain('use="encryption"');
  });

  it('advertises signed requests and the encryption key when the org turns them on', async () => {
    const xml = await buildSamlMetadata(ORG, { signAuthnRequests: true, encryptAssertions: true });
    expect(xml).toContain('AuthnRequestsSigned="true"');
    expect(xml).toContain('use="encryption"');
    const encCert = SP_KEYS.encryption.certificate.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '');
    expect(xml.replace(/\s+/g, '')).toContain(encCert);
  });
});

describe('SP-initiated authorize request', () => {
  it('redirects to the IdP SSO url carrying the state as RelayState', async () => {
    const url = await buildSamlAuthorizeUrl(cfg(), 'state-abc');
    expect(url.startsWith('https://idp.test/sso/saml?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('RelayState')).toBe('state-abc');
    expect(params.get('SAMLRequest')).toBeTruthy();
  });

  it('refuses to build a request for an incomplete configuration', async () => {
    await expect(buildSamlAuthorizeUrl(cfg({ certificates: [] }), 's')).rejects.toThrow('SAML_INCOMPLETE_CONFIG');
  });

  it('leaves the AuthnRequest unsigned by default', async () => {
    const params = new URL(await buildSamlAuthorizeUrl(cfg(), 's')).searchParams;
    expect(params.get('Signature')).toBeNull();
    expect(params.get('SigAlg')).toBeNull();
  });

  it('signs the AuthnRequest with the SP signing key when the org opts in', async () => {
    const url = new URL(await buildSamlAuthorizeUrl(cfg({ signAuthnRequests: true }), 'state-s'));
    const sigAlg = url.searchParams.get('SigAlg');
    const signature = url.searchParams.get('Signature');
    expect(sigAlg).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    expect(signature).toBeTruthy();
    // Verify exactly as an IdP does: over the encoded SAMLRequest/RelayState/SigAlg octets.
    const raw = url.search.slice(1).split('&').filter((p) => !p.startsWith('Signature=')).join('&');
    const ok = (await import('crypto')).default.createVerify('RSA-SHA256').update(raw)
      .verify(SP_KEYS.signing.certificate, signature!, 'base64');
    expect(ok).toBe(true);
  });
});

describe('validateSamlResponse — accepting a good assertion', () => {
  it('returns the verified identity with mapped attributes', async () => {
    const identity = await validateSamlResponse(cfg(), await solicited(), 'state-1', 'state-1');
    expect(identity).toEqual({
      subject: 'ada@acme.test',
      issuer: IDP_ENTITY,
      email: 'ada@acme.test',
      name: 'Ada Lovelace',
      groups: ['Engineering', 'Admins'],
      // The IdP's handle on the sign-in, kept for Single Logout.
      session: {
        nameID: 'ada@acme.test',
        nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: expect.any(String),
      },
    });
  });

  it('reads email, name and groups from the org-configured attribute names', async () => {
    const response = await solicited({
      attributes: {
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'grace@acme.test',
        'http://schemas.microsoft.com/identity/claims/displayname': 'Grace Hopper',
        'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups': ['Platform'],
      },
    });
    const identity = await validateSamlResponse(cfg({
      attributes: {
        email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        name: 'http://schemas.microsoft.com/identity/claims/displayname',
        groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
      },
    }), response, 'state-1', 'state-1');
    expect(identity.email).toBe('grace@acme.test');
    expect(identity.name).toBe('Grace Hopper');
    expect(identity.groups).toEqual(['Platform']);
  });

  it('falls back to an email-shaped NameID when no email attribute is present', async () => {
    const identity = await validateSamlResponse(cfg(), await solicited({ attributes: {} }), 'state-1', 'state-1');
    expect(identity.email).toBe('ada@acme.test');
    expect(identity.groups).toEqual([]);
  });

  it('enforces the org\'s pinned email domains', async () => {
    await expect(
      validateSamlResponse(cfg({ allowedEmailDomains: ['other.test'] }), await solicited(), 's', 's'),
    ).rejects.toThrow('SAML_EMAIL_DOMAIN_NOT_ALLOWED');
  });
});

describe('validateSamlResponse — refusals', () => {
  it('refuses an assertion issued for a different audience', async () => {
    const response = await solicited({ audience: 'https://someone-else.test/sp' });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an expired assertion', async () => {
    const response = await solicited({ notBeforeMs: -60 * 60_000, notOnOrAfterMs: -30 * 60_000 });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an assertion that is not yet valid', async () => {
    const response = await solicited({ notBeforeMs: 30 * 60_000, notOnOrAfterMs: 60 * 60_000 });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('tolerates small clock skew either side of the window', async () => {
    // Inside the 60s allowance: NotBefore 30s in the future, which a strict
    // comparison would reject and an IdP a few seconds ahead of us routinely
    // produces.
    const response = await solicited({ notBeforeMs: 30_000, notOnOrAfterMs: 5 * 60_000 });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).resolves.toMatchObject({ email: 'ada@acme.test' });
  });

  it('refuses an assertion signed by a key the org does not trust', async () => {
    const attacker = generateIdpKeyPair();
    const response = await solicited({ signWith: attacker.privateKey });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an unsigned assertion even inside a signed response', async () => {
    const response = await solicited({ unsignedAssertion: true });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an assertion from a different issuer', async () => {
    const response = await solicited({ issuer: 'https://evil-idp.test/saml' });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a RelayState that does not match the state we minted', async () => {
    await expect(validateSamlResponse(cfg(), await solicited(), 'their-state', 'our-state'))
      .rejects.toThrow('SAML_INVALID_STATE');
  });
});

describe('IdP-initiated sign-in', () => {
  it('refuses a response with no InResponseTo', async () => {
    const response = goodResponse({ inResponseTo: undefined });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_IDP_INITIATED');
  });

  it('recognizes a solicited response', () => {
    expect(isSpInitiatedResponse(goodResponse({ inResponseTo: '_req-1' }))).toBe(true);
    expect(isSpInitiatedResponse(goodResponse({ inResponseTo: undefined }))).toBe(false);
    expect(isSpInitiatedResponse('not base64 xml at all')).toBe(false);
  });
});

describe('replay', () => {
  it('accepts an assertion once and refuses the same assertion replayed into a fresh flow', async () => {
    // The replay that matters: an attacker who captures an assertion starts
    // their OWN sign-in and presents it there, so the request-id binding is
    // satisfied and only the assertion-id cache stands in the way.
    const first = await solicited({ assertionId: '_fixed-assertion-id' });
    await expect(validateSamlResponse(cfg(), first, 's', 's')).resolves.toMatchObject({ email: 'ada@acme.test' });

    const replayed = await solicited({ assertionId: '_fixed-assertion-id' });
    await expect(validateSamlResponse(cfg(), replayed, 's', 's')).rejects.toThrow('SAML_REPLAYED_ASSERTION');
  });

  it('does not burn the assertion id when verification fails, so a later valid assertion still works', async () => {
    const attacker = generateIdpKeyPair();
    const forged = await solicited({ assertionId: '_shared-id', signWith: attacker.privateKey });
    await expect(validateSamlResponse(cfg(), forged, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
    const genuine = await solicited({ assertionId: '_shared-id' });
    await expect(validateSamlResponse(cfg(), genuine, 's', 's')).resolves.toMatchObject({ email: 'ada@acme.test' });
  });

  it('refuses a response answering a request this deployment never made', async () => {
    const response = goodResponse({ inResponseTo: '_never-minted' });
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('certificate rotation overlap', () => {
  it('accepts assertions signed by EITHER certificate while both are trusted', async () => {
    const incoming = generateIdpKeyPair();
    const trustBoth = cfg({ certificates: [incoming.certificate, keys.certificate] });

    // Signed by the OUTGOING key — still accepted while its certificate is listed.
    await expect(validateSamlResponse(trustBoth, await solicited(), 's', 's'))
      .resolves.toMatchObject({ email: 'ada@acme.test' });
    // Signed by the INCOMING key — accepted from the moment its certificate is added.
    await expect(validateSamlResponse(trustBoth, await solicited({}, incoming), 's', 's'))
      .resolves.toMatchObject({ email: 'ada@acme.test' });
  });

  it('refuses the retired certificate once the window is closed', async () => {
    const incoming = generateIdpKeyPair();
    const trustNewOnly = cfg({ certificates: [incoming.certificate] });
    await expect(validateSamlResponse(trustNewOnly, await solicited(), 's', 's'))
      .rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('encrypted assertions', () => {
  it('decrypts an assertion encrypted to the SP key when the org requires encryption', async () => {
    const response = await buildEncryptedSamlResponse(keys, {
      issuer: IDP_ENTITY,
      audience: SP_ENTITY,
      destination: ACS,
      nameId: 'ada@acme.test',
      attributes: { email: 'ada@acme.test', groups: ['Engineering'] },
      inResponseTo: await mintRequestId(),
    }, SP_KEYS.encryption.certificate);
    await expect(validateSamlResponse(cfg({ encryptAssertions: true }), response, 's', 's'))
      .resolves.toMatchObject({ email: 'ada@acme.test', groups: ['Engineering'] });
  });

  it('refuses a PLAINTEXT assertion when the org requires encryption (no downgrade)', async () => {
    await expect(validateSamlResponse(cfg({ encryptAssertions: true }), await solicited(), 's', 's'))
      .rejects.toThrow('SAML_ENCRYPTION_REQUIRED');
  });

  it('refuses an ENCRYPTED assertion when the org has not turned encryption on', async () => {
    const response = await buildEncryptedSamlResponse(keys, {
      issuer: IDP_ENTITY,
      audience: SP_ENTITY,
      destination: ACS,
      nameId: 'ada@acme.test',
      inResponseTo: await mintRequestId(),
    }, SP_KEYS.encryption.certificate);
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_UNEXPECTED_ENCRYPTION');
  });

  it('refuses an assertion encrypted to some OTHER key', async () => {
    const other = generateSpKeys();
    const response = await buildEncryptedSamlResponse(keys, {
      issuer: IDP_ENTITY,
      audience: SP_ENTITY,
      destination: ACS,
      nameId: 'ada@acme.test',
      inResponseTo: await mintRequestId(),
    }, other.encryption.certificate);
    await expect(validateSamlResponse(cfg({ encryptAssertions: true }), response, 's', 's'))
      .rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('dry-run (test connection) isolation', () => {
  it('accepts a test assertion only through the test path', async () => {
    const testRequestId = requestIdFromAuthorizeUrl(await buildSamlAuthorizeUrl(cfg(), 'ssotest.x', { test: true }));
    const response = goodResponse({ inResponseTo: testRequestId });
    // The SIGN-IN path has never heard of this request id.
    await expect(validateSamlResponse(cfg(), response, 's', 's')).rejects.toThrow('SAML_INVALID_ASSERTION');
    // A fresh assertion answering the same test request is accepted by the test path.
    const again = goodResponse({ inResponseTo: testRequestId });
    await expect(validateSamlResponse(cfg(), again, 's', 's', { test: true })).resolves.toMatchObject({ email: 'ada@acme.test' });
  });

  it('never lets a sign-in assertion satisfy the test path', async () => {
    const response = await solicited();
    await expect(validateSamlResponse(cfg(), response, 's', 's', { test: true })).rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('single logout — SP-initiated', () => {
  const session = { nameID: 'ada@acme.test', nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', sessionIndex: '_sess-1' };

  it('builds a SIGNED LogoutRequest to the IdP SLO url naming NameID + SessionIndex', async () => {
    const url = new URL(await buildSamlLogoutRequestUrl(cfg({ sloUrl: IDP_SLO }), session, ''));
    expect(`${url.origin}${url.pathname}`).toBe(IDP_SLO);
    expect(url.searchParams.get('Signature')).toBeTruthy();
    const xml = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    expect(xml).toContain('LogoutRequest');
    expect(xml).toContain('ada@acme.test');
    expect(xml).toContain('_sess-1');
    expect(xml).toContain(`<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${SP_ENTITY}</saml:Issuer>`);
  });

  it('refuses without an IdP SLO url', async () => {
    await expect(buildSamlLogoutRequestUrl(cfg(), session, '')).rejects.toThrow('SAML_SLO_NOT_CONFIGURED');
  });

  it('accepts the IdP\'s signed LogoutResponse answering our request — once', async () => {
    const url = await buildSamlLogoutRequestUrl(cfg({ sloUrl: IDP_SLO }), session, '');
    const inResponseTo = requestIdFromLogoutUrl(url);
    const msg = buildRedirectLogoutResponse(keys, { issuer: IDP_ENTITY, destination: SLO, inResponseTo });
    await expect(validateSamlLogoutMessage(cfg({ sloUrl: IDP_SLO }), { binding: 'redirect', ...msg }))
      .resolves.toEqual({ kind: 'response' });
    // Consumed: the same response can't be replayed.
    await expect(validateSamlLogoutMessage(cfg({ sloUrl: IDP_SLO }), { binding: 'redirect', ...msg }))
      .rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('refuses a LogoutResponse answering a request we never sent', async () => {
    const msg = buildRedirectLogoutResponse(keys, { issuer: IDP_ENTITY, destination: SLO, inResponseTo: '_never' });
    await expect(validateSamlLogoutMessage(cfg({ sloUrl: IDP_SLO }), { binding: 'redirect', ...msg }))
      .rejects.toThrow('SAML_INVALID_LOGOUT');
  });
});

describe('single logout — IdP-initiated', () => {
  const base = { issuer: IDP_ENTITY, destination: SLO, nameId: 'ada@acme.test', sessionIndex: '_sess-9' };

  it('accepts a signed redirect-binding LogoutRequest and reports whose session', async () => {
    const msg = buildRedirectLogoutRequest(keys, { ...base, relayState: 'rs-1' });
    const out = await validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg });
    expect(out).toMatchObject({ kind: 'request', session: { nameID: 'ada@acme.test', sessionIndex: '_sess-9' } });
  });

  it('REFUSES an unsigned redirect-binding LogoutRequest (node-saml alone would accept it)', async () => {
    const msg = buildRedirectLogoutRequest(keys, { ...base, unsigned: true });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg })).rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('refuses a LogoutRequest signed by a key the org does not trust', async () => {
    const attacker = generateIdpKeyPair();
    const msg = buildRedirectLogoutRequest(keys, { ...base, signWith: attacker.privateKey });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg })).rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('refuses a LogoutRequest from another issuer', async () => {
    const msg = buildRedirectLogoutRequest(keys, { ...base, issuer: 'https://evil.test/idp' });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg })).rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('refuses a replayed LogoutRequest', async () => {
    const msg = buildRedirectLogoutRequest(keys, { ...base, id: '_fixed-logout' });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg })).resolves.toMatchObject({ kind: 'request' });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'redirect', ...msg })).rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('accepts a signed POST-binding LogoutRequest and refuses a forged one', async () => {
    const good = buildPostLogoutRequest(keys, base);
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'post', body: { SAMLRequest: good } }))
      .resolves.toMatchObject({ kind: 'request', session: { nameID: 'ada@acme.test' } });
    const forged = buildPostLogoutRequest(keys, { ...base, signWith: generateIdpKeyPair().privateKey });
    await expect(validateSamlLogoutMessage(cfg(), { binding: 'post', body: { SAMLRequest: forged } }))
      .rejects.toThrow('SAML_INVALID_LOGOUT');
  });

  it('answers with a SIGNED LogoutResponse to the IdP SLO url', async () => {
    const url = new URL(await buildSamlLogoutResponseUrl(cfg({ sloUrl: IDP_SLO }), '_req-77', true, 'rs-1'));
    expect(`${url.origin}${url.pathname}`).toBe(IDP_SLO);
    expect(url.searchParams.get('RelayState')).toBe('rs-1');
    expect(url.searchParams.get('Signature')).toBeTruthy();
    const xml = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLResponse')!, 'base64')).toString('utf8');
    expect(xml).toContain('InResponseTo="_req-77"');
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
  });
});

describe('IdP metadata import', () => {
  const cert = 'MIIC' + 'A'.repeat(120);
  const metadata = (over: { sso?: string; slo?: string; use?: string; extraIdp?: boolean } = {}) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.acme.test/entity">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor${over.use ? ` use="${over.use}"` : ' use="signing"'}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
      ${cert}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIENCRYPTIONONLY${'B'.repeat(80)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${over.slo ?? 'https://idp.acme.test/slo'}"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.acme.test/sso/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${over.sso ?? 'https://idp.acme.test/sso/redirect'}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

  it('extracts entityID, the Redirect SSO/SLO endpoints and the SIGNING certificates only', async () => {
    const parsed = await parseIdpMetadata(metadata());
    expect(parsed).toEqual({
      entityId: 'https://idp.acme.test/entity',
      ssoUrl: 'https://idp.acme.test/sso/redirect',
      sloUrl: 'https://idp.acme.test/slo',
      certificates: [expect.stringContaining(cert.slice(0, 40))],
      wantsSignedRequests: true,
    });
    expect(parsed.certificates[0]).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(parsed.certificates.join('')).not.toContain('ENCRYPTIONONLY');
  });

  it('treats a KeyDescriptor with no `use` as a signing key', async () => {
    const parsed = await parseIdpMetadata(metadata({ use: '' }).replace(' use=""', ''));
    expect(parsed.certificates).toHaveLength(1);
  });

  it('refuses a non-https SSO endpoint, a non-metadata document, and garbage', async () => {
    await expect(parseIdpMetadata(metadata({ sso: 'http://idp.acme.test/sso' }))).rejects.toThrow('SAML_METADATA_INVALID');
    await expect(parseIdpMetadata('<foo/>')).rejects.toThrow('SAML_METADATA_INVALID');
    await expect(parseIdpMetadata('not xml <<<')).rejects.toThrow('SAML_METADATA_INVALID');
  });

  it('drops a non-https SLO endpoint rather than storing it', async () => {
    const parsed = await parseIdpMetadata(metadata({ slo: 'http://idp.acme.test/slo' }));
    expect(parsed.sloUrl).toBeUndefined();
  });
});
