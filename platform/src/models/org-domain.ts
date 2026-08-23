// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Document, Schema, model } from 'mongoose';

/**
 * A verified email domain owned by an organization, used for domain-based org
 * discovery + join (P2b). A domain becomes usable for discovery ONLY after it is
 * verified (DNS TXT challenge) AND `autoJoin` is not `off` — an unverified or
 * off-mode domain never surfaces to a signing-up user, so this is not a
 * tenant-enumeration oracle.
 *
 * `domain` is globally unique: a domain maps to at most one org (first to add
 * claims it; verification proves ownership). This prevents a second org from
 * claiming a domain another org already registered.
 *
 * `autoJoin`:
 *   - `off`     — registered but not offered for discovery (default until an
 *                 admin opts in).
 *   - `request` — matching signups may REQUEST to join; an admin approves.
 *   - `auto`    — matching signups join immediately as a member (use only for
 *                 domains you fully control).
 */
export type DomainJoinMode = 'off' | 'request' | 'auto';
export const DOMAIN_JOIN_MODES: readonly DomainJoinMode[] = ['off', 'request', 'auto'];

export interface OrgDomainDocument extends Document {
  orgId: string;
  domain: string;
  verified: boolean;
  /** Random token the admin publishes as a DNS TXT record to prove ownership.
   *  RETAINED after verification (hidden from the API once verified) so the
   *  periodic re-verification sweep can re-check the same record. */
  verificationToken: string;
  /** When the domain last passed (re-)verification — drives the staleness sweep. */
  verifiedAt?: Date;
  autoJoin: DomainJoinMode;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const orgDomainSchema = new Schema<OrgDomainDocument>(
  {
    orgId: { type: String, required: true, index: true },
    domain: { type: String, required: true, lowercase: true, trim: true },
    verified: { type: Boolean, default: false },
    verificationToken: { type: String, required: true },
    verifiedAt: { type: Date },
    autoJoin: { type: String, enum: DOMAIN_JOIN_MODES as unknown as string[], default: 'off' },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'org_domains' },
);

// A VERIFIED domain belongs to at most one org (first to verify wins). Uniqueness
// is scoped to verified rows so an unverified registration can't squat the global
// namespace and permanently block the real owner from ever verifying it.
orgDomainSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { verified: true } });
// A given org registers a domain at most once.
orgDomainSchema.index({ orgId: 1, domain: 1 }, { unique: true });

export default model<OrgDomainDocument>('OrgDomain', orgDomainSchema);
