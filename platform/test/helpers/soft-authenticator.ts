// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A SOFTWARE passkey authenticator for driving the real WebAuthn verification
 * (`@simplewebauthn/server`) end to end, without a browser or a mocked library.
 *
 * It holds one ES256 (P-256) credential and produces exactly the bytes a real
 * authenticator + browser would:
 *   - registration: a `none`-attestation `attestationObject` (CBOR), whose
 *     `authData` carries rpIdHash / flags (UP|UV|AT) / signCount / the attested
 *     credential data (AAGUID, credential id, COSE public key), plus the
 *     `clientDataJSON` the browser would build;
 *   - authentication: `authData` (rpIdHash / flags / signCount) and a DER
 *     ECDSA signature over `authData || SHA-256(clientDataJSON)`.
 *
 * The CBOR encoder is hand-rolled (only the major types WebAuthn needs) rather
 * than borrowed from a transitive dependency, so the fixture does not break when
 * the library swaps its CBOR implementation.
 */

/* eslint-disable no-bitwise -- CBOR heads and authenticator flags are bit fields by definition. */

import crypto from 'crypto';

// -- Minimal CBOR encoder -----------------------------------------------------

type CborValue = number | string | Uint8Array | Map<CborValue, CborValue> | CborValue[];

function head(major: number, length: number): Buffer {
  const m = major << 5;
  if (length < 24) return Buffer.from([m | length]);
  if (length < 0x100) return Buffer.from([m | 24, length]);
  if (length < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

/** Encode `value` as CBOR (unsigned/negative ints, byte/text strings, arrays, maps). */
export function cborEncode(value: CborValue): Buffer {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('cborEncode: integers only');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf-8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cborEncode)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cborEncode(k), cborEncode(v));
  return Buffer.concat(parts);
}

// -- Authenticator ------------------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');
const sha256 = (data: Uint8Array | string): Buffer => crypto.createHash('sha256').update(data).digest();

function aaguidBytes(aaguid: string): Buffer {
  const hex = aaguid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`bad AAGUID ${aaguid}`);
  return Buffer.from(hex, 'hex');
}

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export interface SoftAuthenticatorOptions {
  rpId: string;
  origin: string;
  /** The model the authenticator claims (default: all-zero = names no model). */
  aaguid?: string;
  /** Whether to report user verification (default true). */
  userVerified?: boolean;
}

/** The JSON shapes `@simplewebauthn/server` verifies (structurally typed here). */
export interface SoftRegistrationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
}
export interface SoftAuthenticationResponse {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer = crypto.randomBytes(32);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  /** The signature counter the NEXT assertion will carry (incremented on each). */
  signCount = 0;
  /** The user handle captured at registration (echoed on discoverable sign-in). */
  userHandle?: string;

  constructor(private readonly opts: SoftAuthenticatorOptions) {}

  get id(): string {
    return b64url(this.credentialId);
  }

  private flags(extra = 0): number {
    return FLAG_UP | (this.opts.userVerified === false ? 0 : FLAG_UV) | extra;
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.opts.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf-8');
  }

  /** The credential's public key as a COSE_Key (EC2 / P-256 / ES256). */
  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cborEncode(new Map<CborValue, CborValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
  }

  /** Answer `navigator.credentials.create()` for the given options. */
  register(options: { challenge: string; user: { id: string } }, overrides: { origin?: string; rpId?: string } = {}): SoftRegistrationResponse {
    this.userHandle = options.user.id;
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? this.opts.rpId),
      Buffer.from([this.flags(FLAG_AT)]),
      counterBytes(this.signCount),
      aaguidBytes(this.opts.aaguid ?? '00000000-0000-0000-0000-000000000000'),
      idLen,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = cborEncode(new Map<CborValue, CborValue>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, overrides.origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /**
   * Answer `navigator.credentials.get()`. Bumps the counter first unless
   * `counter` pins it (to forge a replayed / cloned assertion).
   */
  assert(
    options: { challenge: string },
    overrides: { counter?: number; origin?: string; userHandle?: string | null } = {},
  ): SoftAuthenticationResponse {
    if (overrides.counter === undefined) this.signCount += 1;
    const counter = overrides.counter ?? this.signCount;
    const authData = Buffer.concat([sha256(this.opts.rpId), Buffer.from([this.flags()]), counterBytes(counter)]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, overrides.origin);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    const userHandle = overrides.userHandle === null ? undefined : (overrides.userHandle ?? this.userHandle);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
    };
  }
}
