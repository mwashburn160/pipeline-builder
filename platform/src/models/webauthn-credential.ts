// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * One registered passkey (WebAuthn credential).
 *
 * Its OWN collection rather than an array on `User`, for two reasons:
 *   1. Passkey sign-in is discoverable — the browser hands back a credential id
 *      before we know who the user is, so the lookup has to be keyed by
 *      `credentialId`, which only a top-level unique index gives.
 *   2. Every successful assertion writes `counter` + `lastUsedAt`. Doing that on
 *      the user document would contend with the token-version and
 *      refresh-session writes that already run there on every sign-in.
 *
 * `publicKey` is the COSE key the authenticator minted, stored raw. It is public
 * by construction (it only verifies signatures) but is never returned by the
 * management API — the list endpoint projects it away.
 *
 * Removed with the user in `services/user-cascade.ts`.
 */
export interface WebAuthnCredentialDocument extends Document {
  _id: Types.ObjectId;
  /** Owning user. Every management query is scoped by this. */
  userId: Types.ObjectId;
  /** Base64URL credential id as the authenticator reports it — globally unique. */
  credentialId: string;
  /** COSE-encoded public key. */
  publicKey: Buffer;
  /**
   * Authenticator signature counter. Many modern (synced) authenticators always
   * report 0; a credential that HAS counted and then counts backwards is the
   * classic clone signal — see `webauthn-service.assertCounterProgressed`.
   */
  counter: number;
  /** Transports the browser reported (`internal`, `hybrid`, `usb`, …). Used to
   *  hint the next ceremony, never to authorize one. */
  transports: string[];
  /** `singleDevice` or `multiDevice` as reported at registration. */
  deviceType: string;
  /** Whether the credential is backed up / synced (a passkey in a keychain). */
  backedUp: boolean;
  /** Authenticator model GUID (lowercase canonical form). Checked against the
   *  org authenticator allowlist at registration, and carried onto passkey
   *  sessions so the allowlist decides whether the sign-in counts as `aal: 2`
   *  in the active org (see `helpers/authenticator-policy.ts`). All-zero when
   *  the authenticator named no model. */
  aaguid?: string;
  /** Attestation statement format the authenticator returned (`none` unless
   *  the registrant's org allowlists models and so asked for `direct`). */
  attestationFmt?: string;
  /** The attestation chain was verified against the FIDO Metadata Service and
   *  the model was on the allowlist at registration time. */
  attestationVerified?: boolean;
  /** User-supplied label ("MacBook Touch ID"). */
  name: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
}

const webAuthnCredentialSchema = new Schema<WebAuthnCredentialDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    credentialId: { type: String, required: true, unique: true, index: true },
    publicKey: { type: Buffer, required: true },
    counter: { type: Number, required: true, default: 0 },
    transports: { type: [String], default: [] },
    deviceType: { type: String, default: 'singleDevice' },
    backedUp: { type: Boolean, default: false },
    aaguid: { type: String },
    attestationFmt: { type: String },
    attestationVerified: { type: Boolean, default: false },
    name: { type: String, required: true, maxlength: 64, trim: true },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
  },
  // `createdAt` is written explicitly (and shown in the UI); there is nothing an
  // `updatedAt` would say that `lastUsedAt` doesn't.
  { timestamps: false },
);

export default mongoose.model<WebAuthnCredentialDocument>('WebAuthnCredential', webAuthnCredentialSchema);
