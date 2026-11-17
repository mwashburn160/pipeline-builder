// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ADVERSARIAL SAML responses against the real verifier
 * (services/saml-service.ts `validateSamlResponse` → node-saml → xml-crypto).
 *
 * `saml-service.test.ts` proves that honest-but-wrong responses (expired, wrong
 * key, wrong issuer, …) are refused. This suite takes the attacker's view: it
 * starts from a GENUINE, correctly signed response — the thing an attacker who
 * captured one, or who holds a real account at the IdP, actually has — and
 * reshapes it:
 *
 *   - XML Signature Wrapping (XSW): the signed element is kept intact but moved
 *     (into `ds:Object`, `samlp:Extensions`, inside another assertion) while an
 *     attacker-written element sits where the SP reads; plus the same-ID and
 *     sibling-before variants. Several are built with a response signature made
 *     by the TRUSTED key, so the assertion-level check is proven on its own,
 *     not only because the outer signature happens to break.
 *   - comment injection in NameID (`user@evil.com<!---->.example.com`):
 *     exclusive c14n drops comments, so the signature still verifies — the SP
 *     must read the SIGNED value, never the text before the comment.
 *   - duplicate assertions, an unsigned assertion inside a signed response;
 *   - wrong Destination / Recipient / Audience;
 *   - replay (same bytes twice; the same assertion re-wrapped for a new flow);
 *   - InResponseTo mismatch (another flow's request, a request never minted,
 *     an InResponseTo edited after signing).
 *
 * Every case must be REFUSED. A case the verifier currently ACCEPTS is marked
 * `it.failing` with the reason, so it reads as a known gap and turns red the
 * day it is fixed (prompting the marker's removal).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import {
  assertionOf,
  b64,
  buildAssertion,
  buildResponseXml,
  responseSignature,
  type AdversarialAssertionOptions,
} from './helpers/saml-adversarial-fixture.js';
import { generateIdpKeyPair, generateSpKeys, requestIdFromAuthorizeUrl, type IdpKeyPair } from './helpers/saml-fixture.js';

const SP_KEYS = generateSpKeys();
jest.unstable_mockModule('../src/services/saml-sp-keys.js', () => ({
  getSamlSpKeys: async () => SP_KEYS,
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  oauth: {
    callbackBaseUrl: 'https://pb.test',
    cleanupIntervalMs: 600_000,
    maxPendingStates: 1000,
    samlClockSkewMs: 60_000,
    samlRequestTtlMs: 600_000,
    samlAssertionReplayTtlMs: 600_000,
    samlHandoffTtlMs: 120_000,
  },
}));
// No Redis: the request-id and assertion-replay caches use their in-process
// fallback, which is the store the replay cases exercise.
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => undefined),
}));

const { buildSamlAuthorizeUrl, validateSamlResponse } = await import('../src/services/saml-service.js');
const { _resetAllPendingStoresForTests } = await import('../src/helpers/pending-state-store.js');

const ORG = 'org-saml-adv';
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
    signAuthnRequests: false,
    encryptAssertions: false,
    ...overrides,
  };
}

/** Start a real SP-initiated flow; the id is what the ACS will demand. */
async function mintRequestId(): Promise<string> {
  return requestIdFromAuthorizeUrl(await buildSamlAuthorizeUrl(cfg(), 'state-1'));
}

const validate = (xml: string, requestId: string, over: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) =>
  validateSamlResponse(cfg(over), b64(xml), 's', 's', { expectedRequestId: requestId });

/** An honest signed assertion for `nameId`, answering `requestId`. */
function assertionFor(requestId: string, over: Partial<AdversarialAssertionOptions> = {}) {
  return buildAssertion({
    issuer: IDP_ENTITY,
    audience: SP_ENTITY,
    recipient: ACS,
    nameId: 'victim@acme.test',
    inResponseTo: requestId,
    attributes: { email: 'victim@acme.test' },
    signWith: keys.privateKey,
    ...over,
  });
}

/** An honest, fully signed response — the artifact every attack starts from. */
function genuineResponse(requestId: string, over: Partial<AdversarialAssertionOptions> = {}) {
  const assertion = assertionFor(requestId, over);
  return {
    assertion,
    ...buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: requestId, body: assertion.xml, signWith: keys.privateKey }),
  };
}

/** The attacker's own assertion: their identity, unsigned (they hold no IdP key). */
function attackerAssertion(requestId: string, over: Partial<AdversarialAssertionOptions> = {}) {
  return assertionFor(requestId, {
    nameId: 'attacker@evil.test', attributes: { email: 'attacker@evil.test' }, signWith: null, ...over,
  });
}

beforeEach(() => {
  keys = generateIdpKeyPair();
  _resetAllPendingStoresForTests();
});

describe('baseline', () => {
  it('accepts the honest response the attacks are built from (so each refusal below is the attack, not the builder)', async () => {
    const req = await mintRequestId();
    await expect(validate(genuineResponse(req).xml, req)).resolves.toMatchObject({ email: 'victim@acme.test', subject: 'victim@acme.test' });
  });
});

describe('XML Signature Wrapping (XSW)', () => {
  it('XSW1: refuses an attacker Response whose copied signature points at the original moved into ds:Object', async () => {
    const req = await mintRequestId();
    const genuine = genuineResponse(req);
    const sig = responseSignature(genuine.xml);
    // The original Response, signature and all, tucked inside the signature it carries.
    const wrapped = sig.replace(/<\/((?:ds:)?)Signature>$/, `<$1Object>${genuine.xml}</$1Object></$1Signature>`);
    const evil = buildResponseXml({
      issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, head: wrapped, body: attackerAssertion(req).xml, signWith: null,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('XSW2: refuses an attacker Response wrapping the original signed Response under samlp:Extensions', async () => {
    const req = await mintRequestId();
    const genuine = genuineResponse(req);
    const evil = buildResponseXml({
      issuer: IDP_ENTITY,
      destination: ACS,
      inResponseTo: req,
      head: `${responseSignature(genuine.xml)}<samlp:Extensions>${genuine.xml}</samlp:Extensions>`,
      body: attackerAssertion(req).xml,
      signWith: null,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('XSW3: refuses an attacker assertion inserted as a sibling BEFORE the signed one (captured response, outer signature now stale)', async () => {
    const req = await mintRequestId();
    const genuine = genuineResponse(req);
    const evilXml = genuine.xml.replace('<saml:Assertion', `${attackerAssertion(req).xml}<saml:Assertion`);
    await expect(validate(evilXml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('XSW3 (trusted outer signature): refuses a sibling-before attacker assertion even when the Response itself is validly signed', async () => {
    const req = await mintRequestId();
    const signed = assertionFor(req);
    const evil = buildResponseXml({
      issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, body: attackerAssertion(req).xml + signed.xml, signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('XSW7/8: refuses an attacker assertion carrying the copied signature while the signed original hides inside it (trusted outer signature)', async () => {
    const req = await mintRequestId();
    const signed = assertionFor(req);
    const sig = responseSignature(signed.xml); // the assertion's only signature
    const original = signed.xml;
    // Attacker assertion: their Subject in the read position, the genuine
    // Signature as a direct child (so it is "the assertion's signature"), and
    // the genuine assertion nested inside it, still verifying by its ID.
    const attacker = attackerAssertion(req).xml.replace(
      '<saml:Subject>',
      `${sig.replace(/<\/((?:ds:)?)Signature>$/, `<$1Object>${original.replace(sig, '')}</$1Object></$1Signature>`)}<saml:Subject>`,
    );
    const evil = buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, body: attacker, signWith: keys.privateKey });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a signed assertion referenced by ID while an unsigned one with the SAME ID is the one read', async () => {
    const req = await mintRequestId();
    const signed = assertionFor(req);
    // Same ID as the signed assertion, attacker's subject, placed where it is
    // read; the signed original stays in the document under Extensions.
    const shadow = attackerAssertion(req, { id: signed.id });
    const evil = buildResponseXml({
      issuer: IDP_ENTITY,
      destination: ACS,
      inResponseTo: req,
      head: `<samlp:Extensions>${signed.xml}</samlp:Extensions>`,
      body: shadow.xml.replace('<saml:Subject>', `${responseSignature(signed.xml)}<saml:Subject>`),
      signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a genuine signed assertion moved under samlp:Extensions with an unsigned attacker assertion in the read position', async () => {
    const req = await mintRequestId();
    const signed = assertionFor(req);
    const evil = buildResponseXml({
      issuer: IDP_ENTITY,
      destination: ACS,
      inResponseTo: req,
      head: `<samlp:Extensions>${signed.xml}</samlp:Extensions>`,
      body: attackerAssertion(req).xml,
      signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('comment injection in NameID', () => {
  /** An honest response for `user@evil.com.example.com` (no email attribute, so
   *  the email IS the NameID), with a comment spliced in AFTER signing. */
  async function injected(): Promise<{ xml: string; req: string }> {
    const req = await mintRequestId();
    const honest = genuineResponse(req, { nameId: 'user@evil.com.example.com', attributes: {} });
    const xml = honest.xml.replace('>user@evil.com.example.com<', '>user@evil.com<!---->.example.com<');
    expect(xml).toContain('user@evil.com<!---->.example.com');
    return { xml, req };
  }

  it('never yields the truncated identity: the verified NameID is the signed one (comments are not significant to c14n)', async () => {
    const { xml, req } = await injected();
    // The signature still verifies (exclusive c14n without comments), and
    // node-saml reads the SIGNED canonical bytes — so the full value comes back.
    const identity = await validate(xml, req);
    expect(identity.email).toBe('user@evil.com.example.com');
    expect(identity.subject).toBe('user@evil.com.example.com');
    expect(identity.session.nameID).toBe('user@evil.com.example.com');
  });

  it('refuses the injected NameID for an org that only trusts evil.com (the truncated value would have passed the domain pin)', async () => {
    const { xml, req } = await injected();
    await expect(validate(xml, req, { allowedEmailDomains: ['evil.com'] })).rejects.toThrow(/SAML_EMAIL_DOMAIN_NOT_ALLOWED|SAML_INVALID_ASSERTION/);
  });

  it('never yields the truncated value from a comment-injected email ATTRIBUTE either', async () => {
    const req = await mintRequestId();
    const honest = genuineResponse(req, { attributes: { email: 'user@evil.com.example.com' } });
    const xml = honest.xml.replace(
      '<saml:AttributeValue>user@evil.com.example.com<',
      '<saml:AttributeValue>user@evil.com<!---->.example.com<',
    );
    await expect(validate(xml, req, { allowedEmailDomains: ['evil.com'] })).rejects.toThrow(/SAML_EMAIL_DOMAIN_NOT_ALLOWED|SAML_INVALID_ASSERTION/);
  });
});

describe('assertion multiplicity and signing', () => {
  it('refuses a validly signed Response carrying TWO validly signed assertions', async () => {
    const req = await mintRequestId();
    const a = assertionFor(req);
    const b = assertionFor(req, { nameId: 'other@acme.test', attributes: { email: 'other@acme.test' } });
    const evil = buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, body: a.xml + b.xml, signWith: keys.privateKey });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a duplicate of the SAME signed assertion appended to a captured response', async () => {
    const req = await mintRequestId();
    const genuine = genuineResponse(req);
    const dup = genuine.xml.replace('</samlp:Response>', `${assertionOf(genuine.xml)}</samlp:Response>`);
    await expect(validate(dup, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an UNSIGNED assertion inside a validly signed Response (assertions must be signed — wantAssertionsSigned)', async () => {
    const req = await mintRequestId();
    const evil = buildResponseXml({
      issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, body: assertionFor(req, { signWith: null }).xml, signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a signed assertion in an UNSIGNED Response (the response layer must be signed too)', async () => {
    const req = await mintRequestId();
    const evil = buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: req, body: assertionFor(req).xml, signWith: null });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('addressing: Destination, Recipient, Audience', () => {
  it('refuses an assertion whose Audience is another SP', async () => {
    const req = await mintRequestId();
    await expect(validate(genuineResponse(req, { audience: 'https://other-sp.test/metadata' }).xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses an assertion whose Audience is ANOTHER ORG on this deployment', async () => {
    const req = await mintRequestId();
    const otherOrg = 'https://pb.test/api/auth/sso/org-someone-else/saml/metadata';
    await expect(validate(genuineResponse(req, { audience: otherOrg }).xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  // Regression: node-saml 5.x only logs a Destination mismatch; saml-service now
  // refuses a signed Response addressed to another endpoint.
  it('refuses a signed Response whose Destination is not our ACS', async () => {
    const req = await mintRequestId();
    const assertion = assertionFor(req);
    const evil = buildResponseXml({
      issuer: IDP_ENTITY, destination: 'https://evil.test/acs', inResponseTo: req, body: assertion.xml, signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  // Regression: the bearer Recipient must be our ACS (SAML profiles §4.1.4.3).
  it('refuses an assertion whose bearer Recipient is not our ACS', async () => {
    const req = await mintRequestId();
    await expect(validate(genuineResponse(req, { recipient: 'https://evil.test/acs' }).xml, req)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });
});

describe('replay', () => {
  it('refuses the byte-identical response presented a second time', async () => {
    const req = await mintRequestId();
    const xml = genuineResponse(req).xml;
    await expect(validate(xml, req)).resolves.toMatchObject({ email: 'victim@acme.test' });
    await expect(validate(xml, req)).rejects.toThrow(/SAML_INVALID_ASSERTION|SAML_REPLAYED_ASSERTION/);
  });

  it('refuses a spent assertion re-wrapped in a fresh, validly signed Response for a NEW flow', async () => {
    const first = await mintRequestId();
    // No SubjectConfirmationData InResponseTo, so only the assertion ID ties
    // the two presentations together — the replay guard must catch it.
    const captured = assertionFor(first, { inResponseTo: undefined });
    const firstXml = buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: first, body: captured.xml, signWith: keys.privateKey }).xml;
    await expect(validate(firstXml, first)).resolves.toMatchObject({ email: 'victim@acme.test' });

    const second = await mintRequestId();
    const replayXml = buildResponseXml({ issuer: IDP_ENTITY, destination: ACS, inResponseTo: second, body: captured.xml, signWith: keys.privateKey }).xml;
    await expect(validate(replayXml, second)).rejects.toThrow('SAML_REPLAYED_ASSERTION');
  });
});

describe('InResponseTo binding', () => {
  it("refuses a response answering ANOTHER flow's (genuinely minted) request", async () => {
    const victimReq = await mintRequestId();
    const attackerReq = await mintRequestId();
    await expect(validate(genuineResponse(victimReq).xml, attackerReq)).rejects.toThrow('SAML_INVALID_STATE');
    // ...and it did not burn the victim's request: their own response still completes.
    await expect(validate(genuineResponse(victimReq).xml, victimReq)).resolves.toMatchObject({ email: 'victim@acme.test' });
  });

  it('refuses a response answering a request this deployment never minted, even when the caller expects that id', async () => {
    const forged = '_never-minted-request-id';
    await expect(validate(genuineResponse(forged).xml, forged)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a captured response whose InResponseTo was edited after signing to match the attacker flow', async () => {
    const victimReq = await mintRequestId();
    const attackerReq = await mintRequestId();
    const edited = genuineResponse(victimReq).xml.split(victimReq).join(attackerReq);
    await expect(validate(edited, attackerReq)).rejects.toThrow('SAML_INVALID_ASSERTION');
  });

  it('refuses a validly signed response whose Response and assertion InResponseTo disagree with the flow', async () => {
    const req = await mintRequestId();
    const other = await mintRequestId();
    // Response layer names the attacker's flow; the signed assertion was issued for another.
    const evil = buildResponseXml({
      issuer: IDP_ENTITY, destination: ACS, inResponseTo: other, body: assertionFor(req).xml, signWith: keys.privateKey,
    });
    await expect(validate(evil.xml, req)).rejects.toThrow('SAML_INVALID_STATE');
  });
});
