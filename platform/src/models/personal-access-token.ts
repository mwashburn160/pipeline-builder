// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { API_KEY_PREFIXES, type ApiKeyPrefix, type AssuranceLevel, type AuthMethod } from '@pipeline-builder/api-core';
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * A named, individually-revocable access key (`pb_pat_…` or `pb_sa_…`).
 *
 * The key is OPAQUE: it carries no claims and no signature, and only its
 * SHA-256 hash is stored here — the secret itself is shown once, at creation,
 * and never again. A caller trades the key at `POST /auth/token/exchange` for a
 * 5-minute JWT; revoking the record therefore stops the key everywhere within
 * one token lifetime, without any service needing to read this collection.
 *
 * `prefix` + `last4` are the only displayable fragments (`pb_pat_…a1b2`).
 * `prefix` also says what kind of principal the key speaks for: exactly ONE
 * owner field is set — `userId` for a person's key (`pb_pat`), or
 * `serviceAccountId` for an org service account's key (`pb_sa`). Every
 * user-facing query filters on `userId`, so a service-account key never shows up
 * on someone's personal keys page.
 */
export interface PersonalAccessTokenDocument extends Document {
  /** Owner when this is a PERSONAL key (`pb_pat`). Unset for `pb_sa` keys. */
  userId?: Types.ObjectId | null;
  /** Owner when this is a SERVICE-ACCOUNT key (`pb_sa`). Unset for `pb_pat`. */
  serviceAccountId?: Types.ObjectId | null;
  /** SHA-256 (hex) of the presented key — the only stored form of the secret. */
  keyHash: string;
  /** Key-kind prefix (`pb_pat` today; `pb_sa` once service accounts ship). */
  prefix: ApiKeyPrefix;
  /** Last four characters of the key, for display alongside `prefix`. */
  last4: string;
  /** User-supplied label. */
  name: string;
  /** Optional narrow scope (least-privilege). Null → the user's full permissions. */
  scope?: string | null;
  /** Org the key was minted against (the org its exchanged tokens are scoped to). */
  organizationId?: string | null;
  /**
   * Optional IP allowlist, enforced at EXCHANGE time (the one place platform
   * sees the presenting client). Entries are exact IPv4/IPv6 addresses or CIDR
   * blocks; an empty/absent list means "any address". Service-account keys only
   * — a person's key follows the person, not a subnet.
   */
  ipAllowlist?: string[] | null;
  /** Summarized client that created the key ("pipeline-manager CLI on macOS"). */
  createdUserAgent?: string | null;
  /** IP the key was created from. Personal data — removed with the record. */
  createdIp?: string | null;
  /**
   * Assurance of the session that CREATED the key (`amr` / `aal` / `auth_time`).
   * An opaque key carries no claims, so the context every exchanged token
   * inherits has to live here — and it is copied verbatim, so exchanging a key
   * can never raise the level the person actually signed in at.
   *
   * A SERVICE-ACCOUNT key has no person behind it, so `amr` is stored EMPTY and
   * `aal` stays 1: there is no human authentication to inherit, and an empty
   * `amr` is what makes a machine credential unable to satisfy any
   * method-specific assurance requirement.
   */
  amr: AuthMethod[];
  aal: AssuranceLevel;
  authTime: Date;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt?: Date | null;
  revoked: boolean;
  revokedAt?: Date | null;
}

const personalAccessTokenSchema = new Schema<PersonalAccessTokenDocument>(
  {
    // Exactly one owner is set (see the interface docs). Neither is `required`
    // at the schema level because which one applies depends on the key kind;
    // `api-key-service` is the single writer and always sets one.
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    serviceAccountId: { type: Schema.Types.ObjectId, ref: 'ServiceAccount', default: null, index: true },
    keyHash: { type: String, required: true, unique: true, index: true },
    prefix: { type: String, required: true, enum: API_KEY_PREFIXES as unknown as string[] },
    last4: { type: String, required: true, maxlength: 8 },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    scope: { type: String, default: null },
    organizationId: { type: String, default: null },
    ipAllowlist: { type: [String], default: undefined },
    createdUserAgent: { type: String, default: null, maxlength: 128 },
    createdIp: { type: String, default: null, maxlength: 64 },
    // Not `required`: mongoose's array-required validator rejects an EMPTY
    // array, and a service-account key legitimately has no auth methods.
    amr: { type: [String], default: undefined },
    aal: { type: Number, required: true },
    authTime: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revoked: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default mongoose.model<PersonalAccessTokenDocument>('PersonalAccessToken', personalAccessTokenSchema);
