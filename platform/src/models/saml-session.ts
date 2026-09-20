// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML Single Logout bookkeeping (controllers/saml-slo.ts).
 *
 * One row per platform session that a SAML sign-in opened: it ties the session
 * slot (`User.refreshSessions[].id`, the token's `sid`) to the IdP's view of the
 * same sign-in — the `NameID` it asserted and the `SessionIndex` of the
 * AuthnStatement. SLO needs both directions:
 *
 *   SP-initiated  — signing out of the session looks the row up by
 *                   (userId, sessionId) to build a LogoutRequest the IdP can match
 *                   to ITS session;
 *   IdP-initiated — a LogoutRequest names (issuer, NameID[, SessionIndex]); the
 *                   rows it matches are the platform sessions to revoke.
 *
 * Rows expire with the refresh token they shadow (TTL index), so the collection
 * never outgrows the set of sessions that could still be live.
 */

import { Schema, model, Document } from 'mongoose';

export interface SamlSessionDocument extends Document {
  userId: string;
  orgId: string;
  /** The platform refresh-session slot id (the access token's `sid`). */
  sessionId: string;
  /** The IdP entity id that issued the assertion. */
  issuer: string;
  nameID: string;
  nameIDFormat?: string;
  sessionIndex?: string;
  expiresAt: Date;
  createdAt: Date;
}

const samlSessionSchema = new Schema<SamlSessionDocument>(
  {
    userId: { type: String, required: true },
    orgId: { type: String, required: true },
    sessionId: { type: String, required: true },
    issuer: { type: String, required: true },
    nameID: { type: String, required: true },
    nameIDFormat: { type: String },
    sessionIndex: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'saml_sessions' },
);

samlSessionSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
samlSessionSchema.index({ orgId: 1, issuer: 1, nameID: 1 });
samlSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default model<SamlSessionDocument>('SamlSession', samlSessionSchema);
