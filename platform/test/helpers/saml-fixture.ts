// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML assertion fixtures, signed for real (#4).
 *
 * The roadmap asks for a Keycloak-in-docker test. That is a useful MANUAL
 * exercise but a bad CI gate — it needs a container, a network and a
 * clock-sensitive handshake. So the suite builds assertions here and signs them
 * with a throwaway RSA key generated per run: every signature, digest,
 * canonicalization and audience/time check that the login path performs is
 * genuinely exercised, deterministically, with no fixture key checked into the
 * repository and nothing to rotate.
 *
 * What that buys, concretely: "wrong signature" means a signature made with a
 * DIFFERENT key over real XML, not a mocked `false`; "certificate rotation
 * overlap" means an assertion signed by key A verifying against a trust list
 * holding B and A.
 *
 * The public half is handed to the login path as a "certificate". node-saml
 * passes whatever PEM it is given straight to the verifier and never parses it
 * as X.509 (it uses the configured trust list, not the document's KeyInfo), so
 * an SPKI `PUBLIC KEY` PEM works exactly like a certificate would — which is
 * what lets this run without generating X.509 material Node cannot mint.
 */

import crypto from 'crypto';
import zlib from 'zlib';
import { SignedXml } from 'xml-crypto';

export const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export interface IdpKeyPair {
  privateKey: string;
  /** The trust-list entry — what an org stores as its IdP signing certificate. */
  certificate: string;
}

/** A throwaway signing key for one test run. */
export function generateIdpKeyPair(): IdpKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    certificate: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/**
 * The AuthnRequest `ID` inside an authorize URL.
 *
 * The login path only accepts a response whose `InResponseTo` names a request
 * THIS deployment minted, so a fixture has to answer a real one. Reading it back
 * off the redirect (DEFLATE-compressed, base64, URL-encoded — the HTTP-Redirect
 * binding) is what lets the tests exercise that binding instead of reaching
 * around it.
 */
export function requestIdFromAuthorizeUrl(url: string): string {
  const encoded = new URL(url).searchParams.get('SAMLRequest');
  if (!encoded) throw new Error('authorize URL carries no SAMLRequest');
  const xml = zlib.inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = xml.match(/\bID="([^"]+)"/);
  if (!id) throw new Error('AuthnRequest carries no ID');
  return id[1];
}

/** SAML's xs:dateTime spelling. */
function instant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Enveloped-sign the element `xpath` selects, appending the Signature to it. */
function signElement(xml: string, xpath: string, privateKey: string): string {
  const sig = new SignedXml({
    privateKey,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: SHA256 });
  sig.computeSignature(xml, { location: { reference: xpath, action: 'append' } });
  return sig.getSignedXml();
}

export interface AssertionOptions {
  /** The IdP's entity id — becomes both Issuer elements. */
  issuer: string;
  /** The SP entity id the assertion is FOR (its AudienceRestriction). */
  audience: string;
  /** The AuthnRequest id this answers. Omit for an IdP-INITIATED response. */
  inResponseTo?: string;
  /** Where the SP said the assertion may be delivered. */
  destination: string;
  nameId: string;
  attributes?: Record<string, string | string[]>;
  /** Overrides for the validity window, as offsets in ms from now. */
  notBeforeMs?: number;
  notOnOrAfterMs?: number;
  /** Fix the assertion id so a replay can present the SAME assertion twice. */
  assertionId?: string;
  /** Sign the assertion + response with THIS key instead of `keys.privateKey` —
   *  how the "bad signature" case is built. */
  signWith?: string;
  /** Skip the assertion-level signature (response-only signing). */
  unsignedAssertion?: boolean;
}

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `_${prefix}${seq}${crypto.randomBytes(8).toString('hex')}`;
}

/** Render one `<saml:Attribute>` with one or more values. */
function attributeXml(name: string, value: string | string[]): string {
  const values = (Array.isArray(value) ? value : [value])
    .map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`)
    .join('');
  return `<saml:Attribute Name="${name}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values}</saml:Attribute>`;
}

/**
 * Build a base64 `SAMLResponse` carrying a signed assertion.
 *
 * Both layers are signed (assertion first, then the enclosing response), which
 * is what the login path demands: a response-only signature leaves the assertion
 * substitutable, an assertion-only signature leaves the response status
 * forgeable.
 */
export function buildSamlResponse(keys: IdpKeyPair, opts: AssertionOptions): string {
  const now = Date.now();
  const notBefore = instant(new Date(now + (opts.notBeforeMs ?? -60_000)));
  const notOnOrAfter = instant(new Date(now + (opts.notOnOrAfterMs ?? 5 * 60_000)));
  const issueInstant = instant(new Date(now));
  const assertionId = opts.assertionId ?? uniqueId('a');
  const responseId = uniqueId('r');
  const signingKey = opts.signWith ?? keys.privateKey;

  const attrs = Object.entries(opts.attributes ?? {}).map(([k, v]) => attributeXml(k, v)).join('');
  const inResponseToAttr = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';

  let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + '<saml:Subject>'
    + `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameId}</saml:NameID>`
    + '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
    + `<saml:SubjectConfirmationData${inResponseToAttr} NotOnOrAfter="${notOnOrAfter}" Recipient="${opts.destination}"/>`
    + '</saml:SubjectConfirmation>'
    + '</saml:Subject>'
    + `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`
    + `<saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction>`
    + '</saml:Conditions>'
    + `<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${assertionId}">`
    + '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>'
    + '</saml:AuthnStatement>'
    + (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '')
    + '</saml:Assertion>';

  if (!opts.unsignedAssertion) {
    assertion = signElement(assertion, "//*[local-name(.)='Assertion']", signingKey);
  }

  const response = '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
    + ` ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${opts.destination}"${inResponseToAttr}>`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    + assertion
    + '</samlp:Response>';

  const signed = signElement(response, "//*[local-name(.)='Response']", signingKey);
  return Buffer.from(signed, 'utf8').toString('base64');
}
