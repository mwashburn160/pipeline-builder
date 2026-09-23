// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Who the person is and how strongly they proved it: the user model, the
 *  step-up factors (passkeys, authenticator app, recovery codes) and the org
 *  policies that govern them. */

import type { QuotaTier } from '@pipeline-builder/api-core';

import type { UserOrgMembership } from './organization';

/**
 * User model.
 *
 * Users can belong to multiple organizations via {@link UserOrgMembership}.
 * The `role` here is the user's role in their **active** organization (from
 * the JWT), not a global role. Use `organizations` to see all memberships.
 * `organizationId` / `organizationName` reflect the currently active org.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  /** Per-org role in the active organization. Derived from UserOrganization, not a global role. */
  role: 'owner' | 'admin' | 'member';
  /**
   * Global super-admin flag carried in the JWT. True for Pipeline Builder
   * operators; supersedes the legacy "is this user in the system org"
   * check. Only set when true to keep payloads small for the common case.
   */
  isSuperAdmin?: boolean;
  /** Active organization ID (user may belong to multiple orgs; see `organizations`) */
  organizationId?: string;
  /** Active organization name */
  organizationName?: string;
  isEmailVerified: boolean;
  /** First-run flag for social-signup users who never named their org / picked a
   *  plan. When true, the auth guard routes them to the onboarding screen. */
  needsOnboarding?: boolean;
  tier?: QuotaTier;
  features?: string[];
  /**
   * Effective fine-grained permissions for the active org (RBAC): the role's
   * base bundle ∪ any custom-group grants; superadmins get all. Client-visible
   * for UI gating only — every privileged action is re-checked server-side.
   */
  permissions?: string[];
  featureOverrides?: Record<string, boolean>;
  /** Which step-up factors this account has — drives what StepUpModal offers. */
  authFactors?: AuthFactors;
  /** The active org's two-factor requirement. Present ONLY when the org
   *  actually requires MFA — absence is the common case, and is what keeps the
   *  banner quiet for everyone else. */
  mfaPolicy?: SessionMfaPolicy;
  /** Whether this account has asked not to be prompted to protect itself.
   *  Present ONLY while the account holds no factor and a suppression is
   *  actually in force — see {@link MfaNudgeState}. */
  mfaNudge?: MfaNudgeState;
  /** All organizations this user belongs to, with per-org roles */
  organizations?: UserOrgMembership[];
  createdAt?: string;
  updatedAt?: string;
}

/** A sign-in provider the user can step up with by signing in again. */
export type ReauthProvider =
  | { type: 'oauth'; provider: string }
  | { type: 'sso'; provider: string; orgId: string; orgName?: string };

/** Step-up factors reported by GET /user/profile. */
export interface AuthFactors {
  hasPassword: boolean;
  /** Registered passkeys. Non-zero ⇒ the step-up modal offers "Use a passkey". */
  passkeyCount: number;
  /** A CONFIRMED authenticator-app enrolment ⇒ the modal offers "Enter a code". */
  hasTotp: boolean;
  providers: ReauthProvider[];
}

/**
 * "Not now" / "don't ask again" for the PASSWORD-ONLY PROMPT — the banner that
 * asks an account with no second factor to protect itself.
 *
 * Deliberately NOT an "MFA enabled" setting: whether the account is protected is
 * derived from {@link AuthFactors}, and a boolean beside it could only ever
 * disagree with it. This says one thing — whether we are still asking.
 *
 * The profile omits the whole field unless a suppression is in force, and omits
 * it entirely for an account that holds a factor (there is nothing to ask).
 */
export interface MfaNudgeState {
  /** ISO deadline of a "Not now". Never a past one — an expired snooze is sent
   *  as nothing at all. */
  snoozedUntil?: string;
  /** ISO time the person chose "don't ask again". Reversible from Security. */
  declinedAt?: string;
}

/**
 * What `GET /user/profile` says about the ACTIVE org's two-factor requirement,
 * alongside the current session's own assurance level. Everything the
 * member-facing banner needs, in one place: whether the requirement is already
 * biting, when it starts to, and whether this session already satisfies it.
 */
export interface SessionMfaPolicy {
  /** Always true when present — the field is omitted for orgs with no policy. */
  requireMfa: true;
  /** The grace period has passed, so a single-factor session is now refused. */
  enforced: boolean;
  /** ISO deadline while a grace period is still running. */
  graceUntil?: string;
  /** ISO end of THIS person's enrolment grace after an approved MFA reset: the
   *  requirement doesn't refuse them until then, so they can enrol a new factor. */
  resetGraceUntil?: string;
  /** This session's assurance level: 2 means it already meets the requirement. */
  aal: 1 | 2;
}

/**
 * An org's full two-factor policy, from `GET /organization/:id/mfa-policy`.
 * Distinct from {@link SessionMfaPolicy}: this is the ADMIN's view (what the org
 * has set and what it inherits), not one member's session state.
 */
export interface OrgMfaPolicy {
  requireMfa: boolean;
  enforced: boolean;
  /** This org's OWN setting, regardless of what a parent org imposes. */
  own: boolean;
  /** The org states its identity provider enforces MFA, which is what makes an
   *  SSO sign-in through it count as two-factor. */
  idpEnforcesMfa: boolean;
  graceUntil?: string;
  requiredSince?: string;
  /** Set when a PARENT org's requirement is what's in force here. */
  inheritedFrom?: string;
  /** Display name of `inheritedFrom`, when resolvable. */
  inheritedFromName?: string;
  /**
   * "Administrative actions require MFA": role, member, invitation, IdP
   * group-mapping, billing, log-export and access-key actions need a session
   * opened with a second factor. Effective value (own OR a parent's).
   */
  adminActionsRequireMfa: boolean;
  /** This org's OWN admin-actions setting, regardless of a parent's. */
  adminActionsOwn: boolean;
  /** The parent org whose admin-actions setting is in force, when not this org's own. */
  adminActionsInheritedFrom?: string;
  adminActionsInheritedFromName?: string;
  /** On a write that changed the admin-actions policy: how many members' sessions
   *  were ended so the change applies to them at once. */
  sessionsRefreshed?: number;
  /** Grace period offered by default when turning the requirement on. */
  defaultGraceDays: number;
  /**
   * How many active members already hold a passkey or an authenticator app —
   * the number that makes "14 days" a decision rather than a guess. Present on
   * the policy READ; a write response carries the policy alone.
   */
  enrolment?: {
    members: number;
    enrolled: number;
    /** Of the members with no factor, how many were prompted and chose "don't
     *  ask again". A count, never names — the org's audit log carries
     *  `user.mfa.prompt_declined` for anyone who needs the who. */
    declined: number;
  };
}

/** The account's recovery codes (one set, shared by every second factor),
 *  from GET /auth/recovery-codes. Never a code. */
export interface RecoveryCodeStatus {
  remaining: number;
  total: number;
  generatedAt: string | null;
}

/** A two-person MFA reset request (`/organization/:id/mfa-resets`). */
export interface MfaResetRequest {
  id: string;
  organizationId: string;
  targetUserId: string;
  targetEmail: string;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedByEmail?: string;
  decidedAt?: string;
  decisionNote?: string;
  result?: { passkeysRemoved: number; totpRemoved: boolean; recoveryCodesRemoved: boolean; graceUntil: string };
}

/** The account's authenticator-app state, from GET /auth/totp/status. */
export interface TotpStatus {
  /** Confirmed and in force — sign-in asks for a code. */
  enabled: boolean;
  /** Started but never confirmed; not a factor, and replaced by the next enrol. */
  pending: boolean;
  activatedAt: string | null;
  lastUsedAt: string | null;
  /** Unspent recovery codes. Zero on an enabled enrolment is worth warning about. */
  recoveryCodesRemaining: number;
  recoveryCodesTotal: number;
  recoveryGeneratedAt: string | null;
  /** Set while the account is locked out after repeated wrong codes. */
  lockedUntil: string | null;
}

/** What POST /auth/totp/enrol returns — shown once, never stored. */
export interface TotpEnrolment {
  /** Base32 secret, for typing into an app that can't scan. */
  secret: string;
  /** `otpauth://totp/…` — the QR payload. */
  otpauthUri: string;
}

/** A password sign-in that still owes a second factor (POST /auth/login). */
export interface MfaChallenge {
  mfaRequired: true;
  challengeId: string;
  /** Unix seconds. */
  expiresAt: number;
  methods: Array<'totp' | 'recovery'>;
}

/** One registered passkey, as GET /auth/webauthn/credentials reports it. */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  /** Never used yet → null. */
  lastUsedAt: string | null;
  /** Synced/backed-up (a keychain passkey) rather than bound to one device. */
  backedUp: boolean;
  transports: string[];
  /** Authenticator model GUID (lowercase), when the authenticator named one. */
  aaguid: string | null;
  /** Registered under an org authenticator allowlist: its attestation was
   *  verified against the FIDO Metadata Service. */
  attestationVerified: boolean;
}

/**
 * A password sign-in whose password no longer meets the org password policy
 * (POST /auth/login or /auth/mfa/verify): no session yet — the person must set
 * a new password of at least `minLength` via /auth/password/change-required.
 */
export interface PasswordChangeChallenge {
  passwordChangeRequired: true;
  challengeId: string;
  /** Unix seconds. */
  expiresAt: number;
  minLength: number;
}

/** GET/PATCH /organization/:id/password-policy. */
export interface OrgPasswordPolicy {
  /** The minimum that applies here (own, or a stricter parent's). */
  minLength: number;
  /** This org's OWN minimum; null = none set (the platform minimum applies). */
  own: number | null;
  platformMinLength: number;
  maxLength: number;
  inheritedFrom?: string;
  inheritedFromName?: string;
}

/** One authenticator model on an allowlist, with its FIDO MDS name if known. */
export interface AuthenticatorModelRef {
  aaguid: string;
  model: string | null;
}

/** GET/PATCH /organization/:id/authenticator-policy. */
export interface OrgAuthenticatorPolicy {
  /** This org's OWN allowlist (empty = none set). */
  own: AuthenticatorModelRef[];
  /** What applies here (own ∩ every ancestor's); null = any model. */
  effective: AuthenticatorModelRef[] | null;
  inheritedFrom: Array<{ id: string; name: string }>;
  /** The FIDO Metadata Service catalog for the picker (empty when unavailable). */
  mds: { available: boolean; models: Array<{ aaguid: string; model: string }> };
  compliance: {
    members: number;
    passkeys: number;
    modelsInUse: Array<{ aaguid: string; count: number; model: string | null }>;
    /** Members holding passkeys the effective list would not accept. */
    nonCompliant: Array<{
      userId: string;
      username: string;
      email: string;
      hasAuthenticatorApp: boolean;
      passkeys: Array<{ id: string; name: string; aaguid: string | null; model: string | null }>;
    }>;
  };
}
