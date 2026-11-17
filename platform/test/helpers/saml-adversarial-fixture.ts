// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Building blocks for ADVERSARIAL SAML responses.
 *
 * `saml-fixture.ts` builds well-formed, honestly signed responses. The attacks
 * here need the pieces separately — a signed assertion on its own, a response
 * envelope signed (or not) around arbitrary content, and an independently
 * chosen Destination / Recipient / InResponseTo per layer — so that a test can
 * take a GENUINE signed artifact and wrap, duplicate or edit it the way an
 * attacker holding one captured response would. Signing is real (xml-crypto,
 * exclusive c14n, enveloped RSA-SHA256), exactly like the base fixture.
 */

import crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import { C14N, ENVELOPED, RSA_SHA256, SHA256 } from './saml-fixture.js';

export const SAMLP_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
export const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';

function instant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let seq = 0;
export function adversarialId(prefix: string): string {
  seq += 1;
  return `_${prefix}${seq}${crypto.randomBytes(8).toString('hex')}`;
}

/** Enveloped-sign the element whose `ID` is `id` (the signature is appended to it). */
export function signById(xml: string, id: string, privateKey: string): string {
  const xpath = `//*[@ID='${id}']`;
  const sig = new SignedXml({ privateKey, signatureAlgorithm: RSA_SHA256, canonicalizationAlgorithm: C14N });
  sig.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: SHA256 });
  sig.computeSignature(xml, { location: { reference: xpath, action: 'append' } });
  return sig.getSignedXml();
}

export interface AdversarialAssertionOptions {
  id?: string;
  issuer: string;
  audience: string;
  nameId: string;
  /** SubjectConfirmationData Recipient. */
  recipient: string;
  /** SubjectConfirmationData InResponseTo (omitted when undefined). */
  inResponseTo?: string;
  attributes?: Record<string, string>;
  /** Sign with this key; `null` leaves the assertion unsigned. */
  signWith: string | null;
}

/** A standalone `<saml:Assertion>` (signed unless `signWith` is null). */
export function buildAssertion(opts: AdversarialAssertionOptions): { id: string; xml: string } {
  const now = Date.now();
  const id = opts.id ?? adversarialId('a');
  const notBefore = instant(new Date(now - 60_000));
  const notOnOrAfter = instant(new Date(now + 5 * 60_000));
  const issued = instant(new Date(now));
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';
  const attrs = Object.entries(opts.attributes ?? {})
    .map(([k, v]) => `<saml:Attribute Name="${k}"><saml:AttributeValue>${v}</saml:AttributeValue></saml:Attribute>`)
    .join('');
  const xml = `<saml:Assertion xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0" IssueInstant="${issued}">`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + '<saml:Subject>'
    + `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameId}</saml:NameID>`
    + '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
    + `<saml:SubjectConfirmationData${irt} NotOnOrAfter="${notOnOrAfter}" Recipient="${opts.recipient}"/>`
    + '</saml:SubjectConfirmation>'
    + '</saml:Subject>'
    + `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`
    + `<saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction>`
    + '</saml:Conditions>'
    + `<saml:AuthnStatement AuthnInstant="${issued}" SessionIndex="${id}">`
    + '<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>'
    + '</saml:AuthnStatement>'
    + (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '')
    + '</saml:Assertion>';
  return { id, xml: opts.signWith ? signById(xml, id, opts.signWith) : xml };
}

export interface AdversarialResponseOptions {
  id?: string;
  issuer: string;
  /** Response-level Destination (omitted when undefined). */
  destination?: string;
  /** Response-level InResponseTo (omitted when undefined). */
  inResponseTo?: string;
  /** Raw XML placed after Status (assertions, extensions, …). */
  body: string;
  /** Raw XML placed before Status (e.g. `<samlp:Extensions>…`). */
  head?: string;
  /** Sign with this key; `null` leaves the response unsigned. */
  signWith: string | null;
}

/** A `<samlp:Response>` around arbitrary content, signed unless `signWith` is null. Returns the XML (not base64). */
export function buildResponseXml(opts: AdversarialResponseOptions): { id: string; xml: string } {
  const id = opts.id ?? adversarialId('r');
  const dest = opts.destination ? ` Destination="${opts.destination}"` : '';
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : '';
  const xml = `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0" IssueInstant="${instant(new Date())}"${dest}${irt}>`
    + `<saml:Issuer>${opts.issuer}</saml:Issuer>`
    + (opts.head ?? '')
    + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
    + opts.body
    + '</samlp:Response>';
  return { id, xml: opts.signWith ? signById(xml, id, opts.signWith) : xml };
}

export const b64 = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');
export const unb64 = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

/**
 * The Response's own `<Signature>` — the LAST one in the document, because
 * {@link signById} appends it after the (already signed) assertion.
 */
export function responseSignature(xml: string): string {
  const all = [...xml.matchAll(/<(?:ds:)?Signature\b[\s\S]*?<\/(?:ds:)?Signature>/g)];
  if (all.length === 0) throw new Error('no Signature');
  return all[all.length - 1][0];
}

/** Everything from `<saml:Assertion` through `</saml:Assertion>` (first occurrence). */
export function assertionOf(xml: string): string {
  const start = xml.indexOf('<saml:Assertion');
  const endTag = '</saml:Assertion>';
  const end = xml.indexOf(endTag, start);
  if (start < 0 || end < 0) throw new Error('no Assertion');
  return xml.slice(start, end + endTag.length);
}
