// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal self-signed X.509 certificate minting for the SAML service-provider
 * keys (services/saml-sp-keys.ts).
 *
 * SAML publishes an SP's keys to the identity provider as X.509 certificates
 * inside the metadata (`<KeyDescriptor>`), and every IdP console expects a
 * certificate there — a bare public key is not accepted. Node's `crypto` can
 * generate the key pair and PARSE a certificate (`X509Certificate`) but cannot
 * CREATE one, so this module DER-encodes the one shape we need by hand:
 *
 *   Certificate (v3), RSA public key, sha256WithRSAEncryption, subject = issuer
 *   = `CN=<commonName>`, a random positive serial, and a validity window.
 *
 * No extensions are emitted: SAML trust is by exact certificate (the IdP pins
 * what it imported), never by chain, so nothing here is ever path-validated.
 * The result is round-tripped through `X509Certificate` and its signature
 * verified before it is returned, so a malformed encoding fails at mint time
 * rather than at the first IdP that tries to read it.
 */

import crypto, { type KeyObject } from 'crypto';

// -- DER primitives --------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 + bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const nullValue = (): Buffer => Buffer.from([0x05, 0x00]);

/** A non-negative INTEGER from big-endian magnitude bytes. */
function integer(magnitude: Buffer): Buffer {
  let bytes = magnitude;
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  // A set high bit would read as negative — prefix a zero byte.
  if (bytes[0] >= 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

/** OBJECT IDENTIFIER from dotted notation. */
function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part % 128];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      chunk.unshift((rest % 128) + 0x80);
      rest = Math.floor(rest / 128);
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** UTCTime before 2050, GeneralizedTime from 2050 on (RFC 5280 §4.1.2.5). */
function time(at: Date): Buffer {
  const year = at.getUTCFullYear();
  const rest = `${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}Z`;
  return year < 2050
    ? tlv(0x17, Buffer.from(`${pad2(year % 100)}${rest}`, 'ascii'))
    : tlv(0x18, Buffer.from(`${year}${rest}`, 'ascii'));
}

/** `CN=<commonName>` as an X.501 Name. */
function commonNameName(commonName: string): Buffer {
  return sequence(set(sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))));
}

const SHA256_WITH_RSA = (): Buffer => sequence(oid('1.2.840.113549.1.1.11'), nullValue());

// -- Public surface --------------------------------------------------------

export interface SelfSignedCertificateOptions {
  /** The RSA key pair the certificate binds. */
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Subject and issuer common name. */
  commonName: string;
  /** Validity in days from now (default 10 years). */
  validDays?: number;
  /** Override "now" (tests). */
  now?: Date;
}

/**
 * Mint a self-signed X.509 v3 certificate for an RSA key pair and return it as
 * PEM. Throws when the key is not RSA or the result does not verify.
 */
export function createSelfSignedCertificate(opts: SelfSignedCertificateOptions): string {
  if (opts.privateKey.asymmetricKeyType !== 'rsa') {
    throw new Error('Self-signed SAML certificates are minted for RSA keys only');
  }
  const now = opts.now ?? new Date();
  // Back-date by an hour so a verifier with a slightly slow clock does not see a
  // certificate from the future.
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + (opts.validDays ?? 3650) * 24 * 60 * 60 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] % 0x7f) + 1; // positive and non-zero leading byte

  const spki = opts.publicKey.export({ type: 'spki', format: 'der' });
  const name = commonNameName(opts.commonName);

  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] EXPLICIT version v3
    integer(serial),
    SHA256_WITH_RSA(),
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
  );
  const signature = crypto.sign('sha256', tbs, opts.privateKey);
  const der = sequence(tbs, SHA256_WITH_RSA(), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

  // Round-trip: an encoding mistake must fail here, not at an IdP.
  const parsed = new crypto.X509Certificate(pem);
  if (!parsed.verify(opts.publicKey)) throw new Error('Minted certificate does not verify');
  return pem;
}
