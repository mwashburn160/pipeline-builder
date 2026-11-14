// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A person's own data, as one JSON artifact (`GET /user/export`) — the
 * per-USER counterpart of the org portability export, so a member (or someone
 * about to delete their account) can take a copy without emailing anyone.
 *
 * What it holds: the account (never a secret — no password hash, token
 * versions, refresh-slot hashes, verification token, or factor secrets), the
 * person's memberships with org names, their access-key METADATA, passkey and
 * authenticator-app enrolment metadata, signed-in sessions, per-org
 * preferences, domain-join requests, and the audit events where they are the
 * actor or the target (newest first, capped and labelled when capped).
 */

import { Types } from 'mongoose';
import { apiKeyService } from './api-key-service.js';
import { PROFILE_USER_NOT_FOUND } from './user-errors.js';
import { userProfileService } from './user-profile-service.js';
import {
  AuditEvent, JoinRequest, Organization, User, UserOrganization, UserPreferences, UserTotp, WebAuthnCredential,
} from '../models/index.js';

/** Audit events carried, newest first. */
export const USER_EXPORT_AUDIT_CAP = 10_000;

/** Account fields that are the person's data rather than a credential or an internal counter. */
const ACCOUNT_FIELDS = 'username email isEmailVerified lastActiveOrgId needsOnboarding createdAt updatedAt oauth mfaNudge';

export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  const uid = new Types.ObjectId(String(userId));
  const account = await User.findById(uid).select(ACCOUNT_FIELDS).lean();
  if (!account) throw new Error(PROFILE_USER_NOT_FOUND);

  const memberships = await UserOrganization.find({ userId: uid }).select('organizationId role isActive createdAt').lean();
  const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.organizationId) } }).select('name').lean();
  const orgName = new Map(orgs.map((o) => [String(o._id), String((o as { name?: string }).name ?? '')]));

  const [accessKeys, sessions, passkeys, totp, preferences, joinRequests, audit] = await Promise.all([
    apiKeyService.list(String(uid)),
    userProfileService.listSessions(String(uid)),
    WebAuthnCredential.find({ userId: uid }).select('name createdAt lastUsedAt transports aaguid').lean(),
    UserTotp.findOne({ userId: uid }).select('createdAt activatedAt lastUsedAt').lean(),
    UserPreferences.find({ userId: uid }).select('-_id -__v').lean(),
    JoinRequest.find({ userId: uid }).select('organizationId email status createdAt decidedAt').lean(),
    AuditEvent.find({ $or: [{ actorId: String(uid) }, { targetId: String(uid) }] })
      .sort({ createdAt: -1, _id: -1 })
      .limit(USER_EXPORT_AUDIT_CAP + 1)
      .select('-prevHash -hash -seq')
      .lean(),
  ]);

  const truncated = audit.length > USER_EXPORT_AUDIT_CAP;
  return {
    exportedAt: new Date().toISOString(),
    userId: String(uid),
    account,
    memberships: memberships.map((m) => ({
      organizationId: String(m.organizationId),
      organizationName: orgName.get(String(m.organizationId)) ?? null,
      role: m.role,
      isActive: m.isActive,
      joinedAt: (m as { createdAt?: Date }).createdAt ?? null,
    })),
    accessKeys,
    sessions,
    passkeys,
    authenticatorApp: totp ?? null,
    preferences,
    joinRequests,
    auditEvents: truncated ? audit.slice(0, USER_EXPORT_AUDIT_CAP) : audit,
    ...(truncated ? { truncated: { auditEvents: { cap: USER_EXPORT_AUDIT_CAP } } } : {}),
  };
}
