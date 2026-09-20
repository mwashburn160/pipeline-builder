// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys (WebAuthn) — every ceremony the platform runs, in one place.
 *
 * Three flows share this module, and deliberately share its verification:
 *   - REGISTRATION  (`/auth/webauthn/register/options` + `/verify`)
 *   - SIGN-IN       (`/auth/webauthn/login/options` + `/verify`) — discoverable
 *     credentials, so the user is identified BY the credential, not before it
 *   - STEP-UP       (`/auth/step-up/webauthn/options` + `/verify`) — issues the
 *     same step-up token the password and provider-re-auth paths issue
 *
 * Invariants worth stating once:
 *   - The relying party (`rpID`, `origins`) comes from config, never from the
 *     request — a `Host:`-derived RP would let a caller pick its own domain.
 *   - Every ceremony is a random id + a challenge held in the SHARED Redis
 *     pending-state store, consumed exactly once, with a ~2-minute TTL. A
 *     registration/step-up ceremony is additionally bound to the user who
 *     started it; a sign-in ceremony can only be bound to the browser holding
 *     the ceremony id, because nobody knows who the user is yet.
 *   - User verification is REQUIRED everywhere: a passkey that only proves
 *     presence is not a factor we would accept for step-up.
 *   - A signature counter that goes backwards is refused and audited
 *     ({@link assertCounterProgressed}).
 *
 * The controller stays thin: this module throws the string sentinels in
 * `webauthn-errors.ts`, which `controllers/webauthn.ts` maps to HTTP.
 */

import crypto from 'crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Types } from 'mongoose';
import {
  WEBAUTHN_ATTESTATION_UNVERIFIABLE,
  WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED,
  WEBAUTHN_CREDENTIAL_EXISTS,
  WEBAUTHN_CREDENTIAL_NOT_FOUND,
  WEBAUTHN_COUNTER_REGRESSION,
  WEBAUTHN_INVALID_CEREMONY,
  WEBAUTHN_LAST_SIGN_IN_METHOD,
  WEBAUTHN_NO_CREDENTIALS,
  WEBAUTHN_VERIFICATION_FAILED,
} from './webauthn-errors.js';
import { config } from '../config/index.js';
import { aaguidPermitted, resolveEffectiveAuthenticatorPolicy } from '../helpers/authenticator-policy.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { loadSignInMethods, retainsSignInMethod } from '../helpers/sign-in-methods.js';
import { User, WebAuthnCredential } from '../models/index.js';

const rp = config.auth.webauthn;

/** What a pending ceremony holds. `userId` is absent for passkey SIGN-IN, where
 *  the user is not known until the credential comes back. */
interface PendingCeremony {
  challenge: string;
  userId?: string;
  /** REGISTRATION only: the org whose authenticator policy governs it (the
   *  registrant's active org when the ceremony started). */
  orgId?: string;
}

/**
 * Ceremony store — the same shared Redis the OAuth/SSO `state` uses, so a
 * multi-replica deployment can start a ceremony on one pod and finish it on
 * another. Three prefixes, never interchangeable: a challenge minted for
 * registration must not be redeemable as a sign-in (or vice versa), which is
 * what separate key spaces buy for free.
 */
function ceremonyStore(kind: 'reg' | 'login' | 'stepup') {
  return createPendingStateStore<PendingCeremony>({
    prefix: `webauthn:${kind}:`,
    ttlMs: rp.challengeTtlMs,
    cleanupIntervalMs: config.oauth.cleanupIntervalMs,
    maxEntries: rp.maxPendingCeremonies,
  });
}

const registrationCeremonies = ceremonyStore('reg');
const loginCeremonies = ceremonyStore('login');
const stepUpCeremonies = ceremonyStore('stepup');

/** Test hook: drop in-memory ceremony state between cases. */
export function _resetCeremoniesForTests(): void {
  for (const s of [registrationCeremonies, loginCeremonies, stepUpCeremonies]) s._resetForTests();
}

/** A ceremony handle the client echoes back on verify. 32 bytes — it is the only
 *  thing binding a SIGN-IN ceremony to the browser that started it. */
function newCeremonyId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** A passkey as the management API reports it (never the public key). */
export interface PasskeySummary {
  id: string;
  name: string;
  /** Authenticator model GUID (lowercase), when the authenticator named one. */
  aaguid: string | null;
  /** The registration's attestation was verified against the FIDO Metadata
   *  Service (only ever true for passkeys registered under an allowlist). */
  attestationVerified: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Synced/backed-up credential (a keychain passkey) rather than one bound to a
   *  single device — surfaced so a person can tell them apart in the list. */
  backedUp: boolean;
  transports: string[];
}

/** The stored fields the credential lookups need (lean, never the whole doc). */
interface StoredCredential {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  credentialId: string;
  publicKey: StoredBinary;
  counter: number;
  transports?: string[];
  backedUp?: boolean;
  aaguid?: string;
}

/** A BSON binary as the driver hands it back — a `Buffer` from a hydrated
 *  document, a `Binary` wrapper from a `.lean()` read (mongoose doesn't set
 *  `promoteBuffers`). Both carry the same bytes; only the wrapper differs. */
type StoredBinary = Buffer | Uint8Array | { buffer: Uint8Array };

/** The COSE public key as SimpleWebAuthn wants it, from either shape. `from`
 *  (not the `Uint8Array` constructor) so the result owns a plain ArrayBuffer,
 *  which is what the library's `Uint8Array_` alias requires. */
function toBytes(value: StoredBinary): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value instanceof Uint8Array ? value : value.buffer);
}

function toSummary(doc: {
  _id: Types.ObjectId;
  name: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
  backedUp?: boolean;
  transports?: string[];
  aaguid?: string;
  attestationVerified?: boolean;
}): PasskeySummary {
  return {
    id: doc._id.toString(),
    name: doc.name,
    aaguid: doc.aaguid ? doc.aaguid.toLowerCase() : null,
    attestationVerified: doc.attestationVerified === true,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt ?? null,
    backedUp: doc.backedUp === true,
    transports: doc.transports ?? [],
  };
}

/** The account's passkeys, newest last (registration order). */
export async function listCredentials(userId: string): Promise<PasskeySummary[]> {
  const docs = await WebAuthnCredential.find({ userId })
    .select('name createdAt lastUsedAt backedUp transports aaguid attestationVerified')
    .sort({ createdAt: 1 })
    .lean();
  return docs.map((d) => toSummary(d as unknown as Parameters<typeof toSummary>[0]));
}

/**
 * The opaque user handle this account's discoverable credentials carry, minted
 * on first use.
 *
 * `findOneAndUpdate` with `$exists: false` in the FILTER makes the mint atomic:
 * two concurrent first-registrations race on the same document and exactly one
 * write lands, so the handle can never be rewritten under a credential that
 * already references it. The loser simply re-reads the winner's value.
 */
export async function ensureWebAuthnUserId(userId: string): Promise<string> {
  const minted = crypto.randomBytes(32).toString('base64url');
  const updated = await User.findOneAndUpdate(
    { _id: userId, webauthnUserId: { $exists: false } },
    { $set: { webauthnUserId: minted } },
    { new: true },
  ).select('+webauthnUserId').lean();
  if (updated?.webauthnUserId) return updated.webauthnUserId;

  const existing = await User.findById(userId).select('+webauthnUserId').lean();
  if (!existing?.webauthnUserId) throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  return existing.webauthnUserId;
}

/** Who a registration ceremony is for, as far as the authenticator is concerned. */
export interface RegistrationSubject {
  userId: string;
  email: string;
  username: string;
  /** The registrant's active org — its authenticator policy governs the ceremony. */
  orgId?: string;
}

/**
 * Whether a registration for `orgId` falls under an authenticator allowlist.
 * A policy read failure counts as "yes" (fail closed): an unreadable policy must
 * not become a way to enrol an unvetted model into an org that restricts them.
 */
async function allowlistFor(orgId: string | undefined): Promise<string[] | null> {
  if (!orgId) return null;
  try {
    return (await resolveEffectiveAuthenticatorPolicy(orgId)).allowed;
  } catch {
    throw new Error(WEBAUTHN_ATTESTATION_UNVERIFIABLE);
  }
}

/**
 * Start a registration. `excludeCredentials` lists what the account already has
 * so the authenticator refuses to enrol the same device twice (the browser
 * surfaces that as `InvalidStateError`, which the UI words as "already
 * registered" rather than an error).
 */
export async function registrationOptions(
  subject: RegistrationSubject,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const handle = await ensureWebAuthnUserId(subject.userId);
  const existing = await WebAuthnCredential.find({ userId: subject.userId })
    .select('credentialId transports').lean();
  // An org that allowlists models needs to SEE the model, provably: direct
  // attestation carries the authenticator's certificate chain, which the verify
  // step checks against the FIDO Metadata Service. Everyone else keeps `none`,
  // which reveals nothing about the device (the privacy-preserving default).
  const allowlisted = (await allowlistFor(subject.orgId)) !== null;

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: subject.email,
    userDisplayName: subject.username,
    userID: Buffer.from(handle, 'base64url'),
    attestationType: allowlisted ? 'direct' : 'none',
    excludeCredentials: existing.map((c) => ({
      id: (c as unknown as StoredCredential).credentialId,
      transports: (c as unknown as StoredCredential).transports ?? [],
    })),
    authenticatorSelection: {
      // Discoverable, or passkey sign-in (which knows no username up front)
      // could never find the credential.
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: rp.challengeTtlMs,
  });

  const ceremonyId = newCeremonyId();
  await registrationCeremonies.put(ceremonyId, {
    challenge: options.challenge,
    userId: subject.userId,
    ...(subject.orgId ? { orgId: subject.orgId } : {}),
  });
  return { ceremonyId, options };
}

/**
 * Finish a registration and store the credential.
 *
 * The ceremony is consumed FIRST (so a failure downstream can't be retried
 * against the same challenge) and only then bound to the caller.
 */
export async function verifyRegistration(
  userId: string,
  ceremonyId: string,
  response: RegistrationResponseJSON,
  name: string,
): Promise<PasskeySummary> {
  const pending = await registrationCeremonies.consume(ceremonyId);
  if (!pending || pending.userId !== userId) throw new Error(WEBAUTHN_INVALID_CEREMONY);

  // Re-resolved at verify (not trusted from options time), so a policy that
  // tightened during the ceremony still applies. The metadata is loaded BEFORE
  // verification because SimpleWebAuthn consults it while verifying the
  // attestation chain.
  const allowed = await allowlistFor(pending.orgId);
  // Loaded on demand — only an allowlisted registration ever needs FIDO metadata.
  if (allowed !== null && !(await (await import('./fido-mds.js')).ensureMds())) {
    throw new Error(WEBAUTHN_ATTESTATION_UNVERIFIABLE);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
  } catch {
    // The library throws for every malformed / mismatched field; none of the
    // details are safe (or useful) to hand back to the caller.
    throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid, fmt, attestationObject } = verification.registrationInfo;
  const attestationVerified = allowed !== null
    ? await assertAttestationAllowed(allowed, aaguid, fmt, attestationObject)
    : false;
  // The unique index is the real guard (it also catches the same authenticator
  // enrolled on a DIFFERENT account); this pre-check just gives the common case
  // a clean 409 instead of a duplicate-key error.
  if (await WebAuthnCredential.exists({ credentialId: credential.id })) {
    throw new Error(WEBAUTHN_CREDENTIAL_EXISTS);
  }
  let created;
  try {
    created = await WebAuthnCredential.create({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      aaguid: aaguid.toLowerCase(),
      attestationFmt: fmt,
      attestationVerified,
      name,
      createdAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new Error(WEBAUTHN_CREDENTIAL_EXISTS);
    throw err;
  }
  return toSummary(created as unknown as Parameters<typeof toSummary>[0]);
}

/**
 * The allowlist check for one registration, AFTER SimpleWebAuthn verified the
 * attestation statement (with the MDS statements seeded, so a known model's
 * certificate chain was checked against that model's own roots). Refuses:
 *   - `none` / self attestation — nothing ties the key to a model at all;
 *   - a model the FIDO Metadata Service does not know (no roots to check);
 *   - a model MDS reports compromised;
 *   - a model not on the allowlist.
 * Returns true (the attestation was verified) when every check passes.
 */
async function assertAttestationAllowed(
  allowed: readonly string[],
  aaguid: string,
  fmt: string,
  attestationObject: Uint8Array,
): Promise<true> {
  if (fmt === 'none') throw new Error(WEBAUTHN_ATTESTATION_UNVERIFIABLE);
  // Full attestation carries a certificate chain (`x5c`); SafetyNet carries a
  // signed JWS instead. Anything else is SELF attestation — signed by the new
  // credential's own key, which proves nothing about what made it.
  let hasChain = fmt === 'android-safetynet';
  if (!hasChain) {
    try {
      const { decodeAttestationObject } = await import('@simplewebauthn/server/helpers');
      const x5c = decodeAttestationObject(attestationObject as Parameters<typeof decodeAttestationObject>[0]).get('attStmt').get('x5c');
      hasChain = Array.isArray(x5c) && x5c.length > 0;
    } catch {
      hasChain = false;
    }
  }
  if (!hasChain) throw new Error(WEBAUTHN_ATTESTATION_UNVERIFIABLE);

  const { lookupModel } = await import('./fido-mds.js');
  const model = await lookupModel(aaguid.toLowerCase());
  if (!model) throw new Error(WEBAUTHN_ATTESTATION_UNVERIFIABLE);
  if (model.compromised) throw new Error(WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED);
  if (!aaguidPermitted({ allowed: [...allowed] }, aaguid)) throw new Error(WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED);
  return true;
}

/**
 * Refuse a credential whose signature counter did not advance.
 *
 * Authenticators that count (security keys) must strictly increase; synced
 * passkeys report 0 forever, which is why the check only fires once a credential
 * has counted at least once. A stored counter > 0 that comes back equal or lower
 * means two authenticators are answering for one credential — a clone.
 */
export function assertCounterProgressed(stored: number, next: number): void {
  if (stored > 0 && next <= stored) throw new Error(WEBAUTHN_COUNTER_REGRESSION);
}

/** What a verified assertion resolves to. */
export interface VerifiedAssertion {
  userId: string;
  credentialId: string;
  /** The passkey's model (AAGUID), carried onto the session so the active
   *  org's authenticator allowlist can be applied at every issuance. */
  aaguid?: string;
  /** The credential record id — the handle the management API uses. */
  id: string;
  name: string;
  backedUp: boolean;
}

/**
 * Verify an assertion against the stored credential and advance its counter.
 * Shared by sign-in and step-up; `expectedUserId` is `null` only for sign-in,
 * where the credential itself names the account.
 *
 * `precheck` runs once the credential is resolved but BEFORE anything is
 * verified or written — sign-in uses it for the user-handle binding, so a
 * refusal there leaves the stored counter exactly as it was.
 */
async function verifyAssertion(
  expectedUserId: string | null,
  pending: PendingCeremony,
  response: AuthenticationResponseJSON,
  precheck?: (ownerId: string) => Promise<void>,
): Promise<VerifiedAssertion> {
  const stored = await WebAuthnCredential.findOne({ credentialId: response.id }).lean() as
    (StoredCredential & { name: string }) | null;
  if (!stored) throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  // Owner binding: a valid assertion for SOMEONE ELSE'S passkey must never
  // satisfy this user's step-up.
  if (expectedUserId !== null && stored.userId.toString() !== expectedUserId) {
    throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  }
  if (precheck) await precheck(stored.userId.toString());

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: toBytes(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports ?? [],
      },
    });
  } catch {
    throw new Error(WEBAUTHN_VERIFICATION_FAILED);
  }
  if (!verification.verified) throw new Error(WEBAUTHN_VERIFICATION_FAILED);

  assertCounterProgressed(stored.counter, verification.authenticationInfo.newCounter);
  await WebAuthnCredential.updateOne(
    { _id: stored._id },
    {
      $set: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
        backedUp: verification.authenticationInfo.credentialBackedUp,
      },
    },
  );

  return {
    userId: stored.userId.toString(),
    credentialId: stored.credentialId,
    ...(stored.aaguid ? { aaguid: stored.aaguid.toLowerCase() } : {}),
    id: stored._id.toString(),
    name: stored.name,
    backedUp: verification.authenticationInfo.credentialBackedUp,
  };
}

/** Start a passkey step-up for a signed-in user. */
export async function stepUpOptions(
  userId: string,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const credentials = await WebAuthnCredential.find({ userId }).select('credentialId transports').lean();
  if (credentials.length === 0) throw new Error(WEBAUTHN_NO_CREDENTIALS);

  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    timeout: rp.challengeTtlMs,
    allowCredentials: credentials.map((c) => ({
      id: (c as unknown as StoredCredential).credentialId,
      transports: (c as unknown as StoredCredential).transports ?? [],
    })),
  });

  const ceremonyId = newCeremonyId();
  await stepUpCeremonies.put(ceremonyId, { challenge: options.challenge, userId });
  return { ceremonyId, options };
}

/** Finish a passkey step-up. The caller issues the step-up token. */
export async function verifyStepUp(
  userId: string,
  ceremonyId: string,
  response: AuthenticationResponseJSON,
): Promise<VerifiedAssertion> {
  const pending = await stepUpCeremonies.consume(ceremonyId);
  if (!pending || pending.userId !== userId) throw new Error(WEBAUTHN_INVALID_CEREMONY);
  return verifyAssertion(userId, pending, response);
}

/**
 * Start a passkey SIGN-IN. No `allowCredentials`: the browser offers whatever
 * discoverable credential it holds for this RP, which is what makes
 * username-less (and autofill) sign-in work. Nothing here identifies a user, so
 * the response leaks nothing about which accounts exist.
 */
export async function loginOptions(): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    timeout: rp.challengeTtlMs,
  });
  const ceremonyId = newCeremonyId();
  await loginCeremonies.put(ceremonyId, { challenge: options.challenge });
  return { ceremonyId, options };
}

/**
 * Finish a passkey SIGN-IN and resolve who signed in.
 *
 * Also asserts the authenticator's `userHandle` matches the account's stored
 * handle. Without that, a credential re-pointed at another account's record
 * would still verify — the handle is what ties the discoverable credential to
 * the identity it was enrolled for.
 */
export async function verifyLogin(
  ceremonyId: string,
  response: AuthenticationResponseJSON,
): Promise<VerifiedAssertion> {
  const pending = await loginCeremonies.consume(ceremonyId);
  if (!pending) throw new Error(WEBAUTHN_INVALID_CEREMONY);

  return verifyAssertion(null, pending, response, async (ownerId) => {
    const handle = response.response.userHandle;
    const user = await User.findById(ownerId).select('+webauthnUserId').lean();
    if (!handle || !user?.webauthnUserId || user.webauthnUserId !== handle) {
      throw new Error(WEBAUTHN_VERIFICATION_FAILED);
    }
  });
}

/** Rename one of the caller's own passkeys. */
export async function renameCredential(userId: string, id: string, name: string): Promise<PasskeySummary> {
  const updated = await WebAuthnCredential.findOneAndUpdate(
    { _id: id, userId },
    { $set: { name } },
    { new: true },
  ).lean();
  if (!updated) throw new Error(WEBAUTHN_CREDENTIAL_NOT_FOUND);
  return toSummary(updated as unknown as Parameters<typeof toSummary>[0]);
}

/**
 * Whether the account keeps a way in after losing this passkey: a password, a
 * linked social/SSO identity, or another passkey. Removing the LAST of
 * everything would lock the person out permanently, so it is refused — the UI
 * says so rather than offering a delete that 409s.
 *
 * The count itself lives in `helpers/sign-in-methods.ts`, shared with the TOTP
 * guard so the two can never disagree about what "a way in" means. (An
 * authenticator app is deliberately NOT one: it is a second factor on a password
 * sign-in, so an account holding only TOTP could not sign in at all.)
 */
async function assertNotLastSignInMethod(userId: string): Promise<void> {
  if (!retainsSignInMethod(await loadSignInMethods(userId), 'passkey')) {
    throw new Error(WEBAUTHN_LAST_SIGN_IN_METHOD);
  }
}

/** Remove one of the caller's own passkeys (see {@link assertNotLastSignInMethod}). */
export async function removeCredential(userId: string, id: string): Promise<PasskeySummary> {
  const existing = await WebAuthnCredential.findOne({ _id: id, userId }).lean();
  if (!existing) throw new Error(WEBAUTHN_CREDENTIAL_NOT_FOUND);
  await assertNotLastSignInMethod(userId);
  await WebAuthnCredential.deleteOne({ _id: id, userId });
  return toSummary(existing as unknown as Parameters<typeof toSummary>[0]);
}
