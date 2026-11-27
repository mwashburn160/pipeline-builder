// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-session slots — one row per signed-in device (`interactive`) or
 * stored machine credential (`machine`, from generate-token). The row's `id` is
 * the `sid` carried by that session's access and refresh tokens.
 *
 * A collection of its own rather than an array on the User document: the auth
 * middleware reads ONE slot by `(userId, id)` on every request that carries a
 * `sid`, and loading (and rewriting) up to 20 embedded slots with the user on
 * each of those was the hot path. Every read and write goes through
 * `services/session/session-store.ts`.
 *
 * VALIDITY. A row is live only while `tokenVersion` equals the user's current
 * `tokenVersion`: "sign out everywhere", a password change and every other hard
 * revocation bump the user's counter, which strands every row at once (the bump
 * sites also delete the rows, but the version check is what makes the bump
 * authoritative even for a row written concurrently). The full validity model
 * is in docs/authentication.md ("Session validity").
 *
 * Rows are purged by the TTL index on `purgeAt` — the latest moment the slot
 * could still renew under the platform's session-lifetime ceiling (see
 * `purgeAtFor` in services/session/refresh-sessions.ts). Nothing is migrated: the collection is
 * new-install state.
 */

import type { AssuranceLevel, AuthMethod } from '@pipeline-builder/api-core';
import mongoose, { Schema, type Types } from 'mongoose';
import { REFRESH_SESSION_KINDS, type RefreshSessionKind } from '../constants/vocabulary.js';

/** A signed-in device's (or stored machine credential's) refresh-token slot. */
export interface RefreshSessionData {
  /** The user the slot belongs to. */
  userId: Types.ObjectId;
  /** Stable slot id, carried as `sid` in that session's access + refresh tokens. */
  id: string;
  kind: RefreshSessionKind;
  /** The user's `tokenVersion` when the slot was opened. The slot is live only
   *  while it still equals the user's current one — a bump ends every slot. */
  tokenVersion: number;
  /** SHA-256 of the slot's current refresh token. */
  hash: string;
  createdAt: Date;
  /** Last refresh / renewal / switch-org of ANY kind (a background poll
   *  included) — what the sessions page shows and the purge time counts from. */
  lastUsedAt: Date;
  /** Last real ACTIVITY on the session: its sign-in, a refresh the client
   *  marked `activity: 'user'`, or a switch-org. A passive refresh (a poll of
   *  an unattended tab) never moves it. The idle timeout counts from here. */
  lastActiveAt: Date;
  /** The org this slot's tokens are scoped to: set when the slot opens, moved
   *  by switch-org (which mints only an access token) and re-pinned on every
   *  renewal to the org it actually resolved. Per slot, so two devices / tabs /
   *  a CLI keep independent orgs. Its session policy bounds the slot's life. */
  activeOrgId?: string;
  /** MACHINE slots: the fixed end of the credential (generate-token's
   *  `expiresIn`). Renewal never extends it; nothing is minted past it. */
  expiresAt?: Date;
  /** When the TTL index removes the row: the slot can no longer renew after it
   *  under any policy (interactive: `authTime` + the platform maximum session
   *  age; machine: `expiresAt`, or the refresh token's end when it has none). */
  purgeAt: Date;
  /** Capability scope of the tokens this slot mints (a narrow machine credential).
   *  Stored server-side so renewal can never widen it. */
  scope?: string;
  /** Permission SUBSET of a permission-scoped machine token (catalog ids). Stored
   *  server-side so renewal re-intersects it with the holder's current
   *  permissions and can never widen it. Absent = full permissions. */
  permissions?: string[];
  /** AAGUID of the passkey that opened a `webauthn` session, so every issuance
   *  can re-apply the active org's authenticator allowlist. */
  aaguid?: string;
  /** The org whose `idpEnforcesMfa` statement earned the slot its `aal: 2` —
   *  honoured only inside that org's lineage (see `enforceOrgAssurance`). */
  aalAssertedBy?: string;
  /** Authentication methods of the sign-in that opened the slot (JWT `amr`). */
  amr: AuthMethod[];
  /** Assurance level of that sign-in (JWT `aal`). Never raised by renewal. */
  aal: AssuranceLevel;
  /** The slot is a BOOTSTRAP-ADMIN ENROLMENT session: it may reach only
   *  enrolment, sign-out and the setup routes. Stored here, not derived per
   *  token, so a refresh of the slot stays exactly as limited. */
  mfaEnrollmentPending?: boolean;
  /** When that sign-in happened (JWT `auth_time`). Never reset by renewal; the
   *  maximum session age counts from here. */
  authTime: Date;
  /** Short client summary ("Chrome on macOS") from the User-Agent — no raw header. */
  userAgent?: string;
  /** Last IP the slot was used from. Personal data: kept only for the slot's
   *  life (dropped with the row); no geolocation. */
  lastIp?: string;
}

const refreshSessionSchema = new Schema<RefreshSessionData>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    id: { type: String, required: true },
    kind: { type: String, enum: [...REFRESH_SESSION_KINDS], required: true },
    tokenVersion: { type: Number, required: true },
    hash: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    lastActiveAt: { type: Date, required: true },
    activeOrgId: { type: String },
    expiresAt: { type: Date },
    purgeAt: { type: Date, required: true },
    scope: { type: String },
    permissions: { type: [String], default: undefined },
    aaguid: { type: String },
    aalAssertedBy: { type: String },
    amr: { type: [String], required: true },
    aal: { type: Number, enum: [1, 2], required: true },
    mfaEnrollmentPending: { type: Boolean },
    authTime: { type: Date, required: true },
    userAgent: { type: String },
    lastIp: { type: String },
  },
  { collection: 'refresh_sessions', versionKey: false },
);

// The per-request lookup (`sid` → slot) and the one-slot-per-id guarantee.
refreshSessionSchema.index({ userId: 1, id: 1 }, { unique: true });
// The per-kind cap trim and the sessions list.
refreshSessionSchema.index({ userId: 1, kind: 1, createdAt: -1 });
refreshSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<RefreshSessionData>('RefreshSession', refreshSessionSchema);
