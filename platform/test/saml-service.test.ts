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
 *     certificate accepts assertions signed by either.
 *
 * The roadmap also asks for a live Keycloak run; that stays a manual exercise
 * (see the fixture module's header for why it isn't the CI gate).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { buildSamlResponse, generateIdpKeyPair, requestIdFromAuthorizeUrl, type IdpKeyPair } from './helpers/saml-fixture.js';

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
  buildSamlMetadata,
  isSpInitiatedResponse,
  samlAcsUrl,
  samlSpEntityId,
  validateSamlResponse,
} = await import('../src/services/saml-service.js');

const ORG = 'org-saml-1';
const IDP_ENTITY = 'https://idp.test/saml/metadata';
const SP_ENTITY = `https://pb.test/api/auth/sso/${ORG}/saml/metadata`;
const ACS = `https://pb.test/api/auth/sso/${ORG}/saml/acs`;

let keys: IdpKeyPair;

function cfg(overrides: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) {
  return {
    orgId: ORG,
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.test/sso/saml',
    certificates: [keys.certificate],
    attributes: {},
    allowedEmailDomains: [],
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

  it('publishes SP metadata naming the ACS with the HTTP-POST binding', () => {
    const xml = buildSamlMetadata(ORG);
    expect(xml).toContain(`entityID="${SP_ENTITY}"`);
    expect(xml).toContain(ACS);
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
    // First release: no single logout anywhere, including in what we advertise.
    expect(xml).not.toContain('SingleLogoutService');
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
