// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML assertion fixtures, signed for real.
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
import { createRequire } from 'module';
import zlib from 'zlib';
import { SignedXml } from 'xml-crypto';
import { createSelfSignedCertificate } from '../../src/helpers/x509-self-signed.js';

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

// -- SP keys, encryption and Single Logout (SAML completeness) --------------


/** A deployment's SP keys, shaped like services/saml-sp-keys.ts returns them —
 *  with REAL self-signed certificates, as an IdP would import them. */
export function generateSpKeys(): {
  signing: { privateKey: string; certificate: string };
  encryption: { privateKey: string; certificate: string };
  testMarkerKey: Buffer;
} {
  const pair = (cn: string) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      certificate: createSelfSignedCertificate({ privateKey, publicKey, commonName: cn }),
    };
  };
  return { signing: pair('sp signing'), encryption: pair('sp encryption'), testMarkerKey: crypto.randomBytes(32) };
}

/** xml-encryption, resolved through node-saml (it is node-saml's dependency,
 *  not the platform's) — the same library the SP decrypts with. */
function xmlenc(): { encrypt: (content: string, opts: Record<string, unknown>, cb: (err: Error | null, out?: string) => void) => void } {
  const here = createRequire(import.meta.url);
  const nodeSamlEntry = here.resolve('@node-saml/node-saml');
  return createRequire(nodeSamlEntry)('xml-encryption');
}

/** Encrypt a (signed) assertion to the SP's encryption certificate. */
export async function encryptAssertion(assertionXml: string, spEncryptionCert: string): Promise<string> {
  const publicKey = crypto.createPublicKey(spEncryptionCert).export({ format: 'pem', type: 'spki' }).toString();
  const encrypted = await new Promise<string>((resolve, reject) => {
    xmlenc().encrypt(assertionXml, {
      rsa_pub: publicKey,
      pem: spEncryptionCert,
      encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
      keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
    }, (err, out) => (err || !out ? reject(err ?? new Error('encrypt failed')) : resolve(out)));
  });
  return `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encrypted}</saml:EncryptedAssertion>`;
}

/**
 * A signed response whose assertion is ENCRYPTED to `spEncryptionCert` — built
 * by taking {@link buildSamlResponse}'s signed assertion, encrypting it, and
 * re-signing the enclosing response.
 */
export async function buildEncryptedSamlResponse(keys: IdpKeyPair, opts: AssertionOptions, spEncryptionCert: string): Promise<string> {
  const plain = Buffer.from(buildSamlResponse(keys, opts), 'base64').toString('utf8');
  const start = plain.indexOf('<saml:Assertion');
  const endTag = '</saml:Assertion>';
  const end = plain.indexOf(endTag);
  if (start < 0 || end < 0) throw new Error('no assertion to encrypt');
  // Rebuild the response around the ENCRYPTED assertion (dropping the old
  // response signature, which followed the assertion), then re-sign it.
  const assertion = plain.slice(start, end + endTag.length);
  const rebuilt = `${plain.slice(0, start)}${await encryptAssertion(assertion, spEncryptionCert)}</samlp:Response>`;
  return Buffer.from(signElement(rebuilt, "//*[local-name(.)='Response']", opts.signWith ?? keys.privateKey), 'utf8').toString('base64');
}

export interface LogoutRequestOptions {
  issuer: string;
  destination: string;
  nameId: string;
  sessionIndex?: string;
  id?: string;
}

function logoutRequestXml(opts: LogoutRequestOptions): string {
  const id = opts.id ?? uniqueId('lr');
  return '<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
    + ` ID="${id}" Version="2.0" IssueInstant="${instant(new Date())}" Destination="${opts.destination}">`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameId}</saml:NameID>`
    + (opts.sessionIndex ? `<samlp:SessionIndex>${opts.sessionIndex}</samlp:SessionIndex>` : '')
    + '</samlp:LogoutRequest>';
}

/** The HTTP-Redirect binding of an IdP LogoutRequest: the query object and the
 *  raw query string, signed (unless `unsigned`) over the exact encoded
 *  `SAMLRequest=…&RelayState=…&SigAlg=…` octets, as the binding specifies. */
export function buildRedirectLogoutRequest(
  keys: IdpKeyPair,
  opts: LogoutRequestOptions & { relayState?: string; unsigned?: boolean; signWith?: string },
): { query: Record<string, string>; rawQuery: string } {
  const encoded = zlib.deflateRawSync(Buffer.from(logoutRequestXml(opts), 'utf8')).toString('base64');
  return signRedirect('SAMLRequest', encoded, keys, opts);
}

/** The HTTP-Redirect binding of an IdP LogoutResponse answering `inResponseTo`. */
export function buildRedirectLogoutResponse(
  keys: IdpKeyPair,
  opts: { issuer: string; destination: string; inResponseTo: string; unsigned?: boolean },
): { query: Record<string, string>; rawQuery: string } {
  const xml = '<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"'
    + ` ID="${uniqueId('lrs')}" Version="2.0" IssueInstant="${instant(new Date())}" Destination="${opts.destination}" InResponseTo="${opts.inResponseTo}">`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    + '</samlp:LogoutResponse>';
  const encoded = zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
  return signRedirect('SAMLResponse', encoded, keys, opts);
}

function signRedirect(
  param: 'SAMLRequest' | 'SAMLResponse',
  encoded: string,
  keys: IdpKeyPair,
  opts: { relayState?: string; unsigned?: boolean; signWith?: string },
): { query: Record<string, string>; rawQuery: string } {
  const query: Record<string, string> = { [param]: encoded };
  let raw = `${param}=${encodeURIComponent(encoded)}`;
  if (opts.relayState) {
    query.RelayState = opts.relayState;
    raw += `&RelayState=${encodeURIComponent(opts.relayState)}`;
  }
  if (!opts.unsigned) {
    query.SigAlg = RSA_SHA256;
    raw += `&SigAlg=${encodeURIComponent(RSA_SHA256)}`;
    const signature = crypto.createSign('RSA-SHA256').update(raw).sign(opts.signWith ?? keys.privateKey, 'base64');
    query.Signature = signature;
    raw += `&Signature=${encodeURIComponent(signature)}`;
  }
  return { query, rawQuery: raw };
}

/** The HTTP-POST binding of an IdP LogoutRequest: an enveloped-signed document. */
export function buildPostLogoutRequest(keys: IdpKeyPair, opts: LogoutRequestOptions & { signWith?: string }): string {
  const signed = signElement(logoutRequestXml(opts), "//*[local-name(.)='LogoutRequest']", opts.signWith ?? keys.privateKey);
  return Buffer.from(signed, 'utf8').toString('base64');
}

/** The id of the SP's LogoutRequest carried in a redirect URL. */
export function requestIdFromLogoutUrl(url: string): string {
  const encoded = new URL(url).searchParams.get('SAMLRequest');
  if (!encoded) throw new Error('logout URL carries no SAMLRequest');
  const xml = zlib.inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = xml.match(/\bID="([^"]+)"/);
  if (!id) throw new Error('LogoutRequest carries no ID');
  return id[1];
}
