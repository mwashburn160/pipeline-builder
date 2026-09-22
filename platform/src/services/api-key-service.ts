// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque access keys: mint, list, revoke — and the exchange that turns one into
 * a short-lived JWT.
 *
 * A key (`pb_pat_…` for a person, `pb_sa_…` for an org service account) is 256
 * bits of CSPRNG output with a naming prefix. Only `sha256(key)` is stored, so
 * the secret exists exactly once, in the create response. Nothing about the
 * key's authority is baked into it: every exchange re-reads the principal, its
 * roles/membership and the org, which is why a privilege reduction takes effect
 * within one token lifetime instead of surviving until the key expires (the old
 * JWT-PAT's documented weakness).
 *
 * Only platform has the collection, so only platform can resolve a key — that is
 * the whole point of the exchange (see `api-core/services/api-key-exchange.ts`).
 */

import {
  API_KEY_TOKEN_TTL_SECONDS,
  apiKeyPrefixOf,
  createLogger,
  generateApiKey,
  hashApiKey,
  isOpaqueApiKey,
  type ApiKeyPrefix,
  type TokenScope,
} from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { MFA_REQUIRED_FOR_ORG } from './auth-errors.js';
import { PROFILE_PAT_LIMIT, PROFILE_USER_NOT_FOUND } from './user-errors.js';
import type { ClientInfo } from '../helpers/client-info.js';
import { publishAccessKeyRevocation } from '../helpers/session-revocation.js';
import { PersonalAccessToken, User, type PersonalAccessTokenDocument } from '../models/index.js';
import { enforceOrgAssurance, membershipForOrg, signApiKeyToken, signServiceAccountToken, type SessionAuth } from '../utils/token.js';

const logger = createLogger('api-key-service');

/** Max active (non-revoked, non-expired) keys a single user may hold. */
const MAX_ACTIVE_KEYS = 50;

/** A key is flagged "expiring soon" in the UI within this window. */
const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

/** The key metadata the API returns — never the secret. */
export interface AccessKeyView {
  /** Record id; the handle used to revoke, and the `jti` of exchanged tokens. */
  id: string;
  name: string;
  /** Key-kind prefix; `pb_pat` for a person's key, `pb_sa` for a service account. */
  prefix: ApiKeyPrefix;
  /** Display-only fragment: `pb_pat_…a1b2`. */
  display: string;
  /** Whose credential this is — a person's (`pb_pat`) or a service account's (`pb_sa`). */
  kind: 'personal' | 'service_account';
  /** Owning service account, for a `service_account` key. Null for a personal one. */
  serviceAccountId: string | null;
  /** Service-account name, so the shared keys list can label the owner. */
  serviceAccountName: string | null;
  scope: string | null;
  /**
   * The key's permission SUBSET ("Selected permissions"), in catalog order, or
   * null for "Full access" (the owner's current permissions). Either way the
   * exchanged token never exceeds what the owner holds at exchange time.
   */
  permissions: string[] | null;
  organizationId: string | null;
  /** Addresses/CIDRs the key may be exchanged from; null = any (service-account keys only). */
  ipAllowlist: string[] | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** Where it was created ("pipeline-manager CLI on macOS"), or null. */
  createdFrom: string | null;
  /** IP it was created from, or null. Kept only as long as the record. */
  createdIp: string | null;
  revoked: boolean;
  status: 'active' | 'expired' | 'revoked';
  /** True when the key has never been exchanged — a candidate to clean up. */
  neverUsed: boolean;
  /** True when an ACTIVE key expires within the next 14 days. */
  expiringSoon: boolean;
}

/** Why an exchange was refused. Recorded in the audit event, never told apart to the caller. */
export type ExchangeRefusal =
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'user_gone'
  | 'authority_revoked'
  // The key's org requires MFA and the key was created from a single-factor
  // session (or its passkey is not on the org's authenticator allowlist).
  | 'mfa_required'
  // Service-account keys (`pb_sa_…`) add their own refusals — see
  // `service-account-service.resolveServiceAccountExchange`.
  | 'account_gone'
  | 'account_disabled'
  | 'ip_not_allowed'
  | 'budget_exhausted'
  | 'orphan_key';

/** A successful exchange, plus what the audit trail needs to attribute it. */
export interface ExchangeSuccess {
  ok: true;
  accessToken: string;
  expiresIn: number;
  keyId: string;
  keyName: string;
  /** The ACTOR the exchanged token speaks for: a user id, or a service-account id. */
  userId: string;
  /** The actor's email — a person's address, or the service account's
   *  `<name>@service-account.invalid` sentinel. */
  userEmail: string;
  /** Which kind of principal the exchanged token carries. */
  principalType: 'user' | 'service_account';
  /** Service-account name when `principalType` is `service_account` — the actor
   *  name the audit row should read. */
  serviceAccountName?: string;
  organizationId?: string;
  scope?: TokenScope;
}

export type ExchangeResult = ExchangeSuccess | { ok: false; reason: ExchangeRefusal };

/**
 * Why a self-rotation was refused. Extends {@link ExchangeRefusal} with the
 * reasons only rotation has: the presented key is a person's (`not_service_account`),
 * the caller asked to revoke the key it presented (`self_revoke`) or a sibling
 * NEWER than it (`newer_sibling` — only a key's predecessors are its to retire),
 * the requested lifetime is out of range or longer than the presented key's own
 * (`expiry_invalid`), or the account is at its active-key cap with nothing safe
 * to retire (`key_limit`).
 */
export type RotationRefusal =
  | ExchangeRefusal
  | 'not_service_account'
  | 'self_revoke'
  | 'newer_sibling'
  | 'expiry_invalid'
  | 'key_limit';

/** A successful self-rotation: the NEW key, plus what the audit row needs. */
export interface RotateSuccess {
  ok: true;
  /** The raw replacement key — returned ONCE, exactly like a mint. */
  key: string;
  view: AccessKeyView;
  /** Record id of the key that was PRESENTED (still live — revoke it separately). */
  previousKeyId: string;
  serviceAccountId: string;
  serviceAccountName: string;
  organizationId: string;
  /** Keys retired to stay under the active-key cap (oldest-first, never the presented one). */
  prunedKeyIds: string[];
}

export type RotateResult = RotateSuccess | { ok: false; reason: RotationRefusal };

/** A successful sibling revoke. `alreadyRevoked` makes the operation idempotent. */
export interface RevokeSiblingSuccess {
  ok: true;
  revokedKeyId: string;
  alreadyRevoked: boolean;
  serviceAccountId: string;
  serviceAccountName: string;
  organizationId: string;
}

export type RevokeSiblingResult = RevokeSiblingSuccess | { ok: false; reason: RotationRefusal };

function toView(
  doc: PersonalAccessTokenDocument & { _id: unknown },
  serviceAccountName?: string | null,
): AccessKeyView {
  const now = Date.now();
  const expiresAt = doc.expiresAt instanceof Date ? doc.expiresAt : new Date(doc.expiresAt);
  let status: AccessKeyView['status'];
  if (doc.revoked) status = 'revoked';
  else if (expiresAt.getTime() <= now) status = 'expired';
  else status = 'active';
  return {
    id: String(doc._id),
    name: doc.name,
    prefix: doc.prefix,
    display: `${doc.prefix}_…${doc.last4}`,
    kind: doc.prefix === 'pb_sa' ? 'service_account' : 'personal',
    serviceAccountId: doc.serviceAccountId ? String(doc.serviceAccountId) : null,
    serviceAccountName: serviceAccountName ?? null,
    scope: doc.scope ?? null,
    permissions: Array.isArray(doc.permissions) ? [...doc.permissions] : null,
    organizationId: doc.organizationId ?? null,
    ipAllowlist: doc.ipAllowlist && doc.ipAllowlist.length > 0 ? [...doc.ipAllowlist] : null,
    createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt)).toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
    createdFrom: doc.createdUserAgent ?? null,
    createdIp: doc.createdIp ?? null,
    revoked: doc.revoked,
    status,
    neverUsed: !doc.lastUsedAt,
    expiringSoon: status === 'active' && expiresAt.getTime() - now <= EXPIRING_SOON_MS,
  };
}

class ApiKeyService {
  /**
   * Mint a key for `userId`. Returns the RAW key once — it is hashed on the way
   * into the collection and can never be read back.
   *
   * `auth` is the creating session's assurance, stored so every exchanged token
   * inherits it (a key can never raise the level the person signed in at).
   *
   * `permissions` is an optional catalog SUBSET the caller has already checked
   * against the creator's current permissions (see the controller); stored
   * as-is and intersected with the owner's live permissions at every exchange.
   */
  async create(
    userId: string,
    input: {
      name: string;
      expiresInSeconds: number;
      scope?: TokenScope;
      permissions?: readonly string[];
      client?: ClientInfo;
      prefix?: ApiKeyPrefix;
    },
    auth: SessionAuth,
  ): Promise<{ key: string; view: AccessKeyView }> {
    const user = await User.findById(userId).select('+tokenVersion lastActiveOrgId');
    if (!user) throw new Error(PROFILE_USER_NOT_FOUND);
    // Cap active keys per user so a compromised session can't mint thousands of
    // durable credentials (mirrors the 20-slot cap on session token history).
    const activeCount = await PersonalAccessToken.countDocuments({
      userId: user._id, revoked: false, expiresAt: { $gt: new Date() },
    });
    if (activeCount >= MAX_ACTIVE_KEYS) throw new Error(PROFILE_PAT_LIMIT);

    const prefix: ApiKeyPrefix = input.prefix ?? 'pb_pat';
    const key = generateApiKey(prefix);
    const doc = await PersonalAccessToken.create({
      userId: user._id,
      keyHash: hashApiKey(key),
      prefix,
      last4: key.slice(-4),
      name: input.name,
      scope: input.scope ?? null,
      ...(input.permissions ? { permissions: [...input.permissions] } : {}),
      organizationId: user.lastActiveOrgId?.toString() ?? null,
      createdUserAgent: input.client?.userAgent ?? null,
      createdIp: input.client?.ip ?? null,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      // The assurance the key inherits lives with the record, not in the key —
      // an opaque key carries no claims at all.
      amr: auth.amr,
      aal: auth.aal,
      authTime: auth.authTime,
      // The passkey model behind a `webauthn` session, so every exchange can
      // re-apply the key's org authenticator allowlist.
      ...(auth.aaguid ? { aaguid: auth.aaguid } : {}),
      ...(auth.aalAssertedBy ? { aalAssertedBy: auth.aalAssertedBy } : {}),
    });
    return { key, view: toView(doc as unknown as PersonalAccessTokenDocument & { _id: unknown }) };
  }

  /** The user's keys, newest first (metadata only — never the secret). */
  async list(userId: string): Promise<AccessKeyView[]> {
    const docs = await PersonalAccessToken.find({ userId }).sort({ createdAt: -1 }).lean();
    return docs.map((d) => toView(d as unknown as PersonalAccessTokenDocument & { _id: unknown }));
  }

  // -------------------------------------------------------------------------
  // Service-account keys (`pb_sa_…`, #2)
  //
  // Same collection, same opaque-key mechanics and the same exchange — the only
  // differences are the owner field (`serviceAccountId` instead of `userId`),
  // the optional per-key IP allowlist, and the absence of any human assurance to
  // inherit (`amr: []`, `aal: 1`). Keeping them here is what makes one key
  // model, one hash lookup and one revocation path serve both principal kinds.
  // -------------------------------------------------------------------------

  /** Mint a key for a service account. Returns the RAW key once. */
  async createForServiceAccount(input: {
    serviceAccountId: Types.ObjectId;
    organizationId: string;
    name: string;
    expiresInSeconds: number;
    ipAllowlist?: readonly string[];
    scope?: TokenScope;
    client?: ClientInfo;
  }): Promise<{ key: string; view: AccessKeyView }> {
    const key = generateApiKey('pb_sa');
    const doc = await PersonalAccessToken.create({
      serviceAccountId: input.serviceAccountId,
      keyHash: hashApiKey(key),
      prefix: 'pb_sa',
      last4: key.slice(-4),
      name: input.name,
      scope: input.scope ?? null,
      organizationId: input.organizationId,
      ...(input.ipAllowlist && input.ipAllowlist.length > 0 ? { ipAllowlist: [...input.ipAllowlist] } : {}),
      createdUserAgent: input.client?.userAgent ?? null,
      createdIp: input.client?.ip ?? null,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      // No person authenticated this credential into existence, so there is no
      // assurance to inherit: an empty `amr` is what keeps the exchanged token
      // from ever satisfying a method-specific assurance requirement.
      amr: [],
      aal: 1,
      authTime: new Date(),
    });
    return { key, view: toView(doc as unknown as PersonalAccessTokenDocument & { _id: unknown }) };
  }

  /** A service account's keys, newest first (metadata only). */
  async listForServiceAccount(serviceAccountId: string): Promise<AccessKeyView[]> {
    const byAccount = await this.listForServiceAccounts([serviceAccountId]);
    return byAccount.get(serviceAccountId) ?? [];
  }

  /**
   * The keys of SEVERAL service accounts, keyed by account id and newest first —
   * ONE query however many accounts are asked for, so listing an org's accounts
   * doesn't cost a query per account. Accounts with no keys are absent.
   */
  async listForServiceAccounts(serviceAccountIds: readonly string[]): Promise<Map<string, AccessKeyView[]>> {
    const byAccount = new Map<string, AccessKeyView[]>();
    const ids = serviceAccountIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return byAccount;
    const docs = await PersonalAccessToken.find({ serviceAccountId: { $in: ids } }).sort({ createdAt: -1 }).lean();
    for (const d of docs) {
      const doc = d as unknown as PersonalAccessTokenDocument & { _id: unknown };
      const key = String(doc.serviceAccountId);
      const held = byAccount.get(key) ?? [];
      held.push(toView(doc));
      byAccount.set(key, held);
    }
    return byAccount;
  }

  /** Active (non-revoked, unexpired) key count — the per-account cap check. */
  async countActiveForServiceAccount(serviceAccountId: string): Promise<number> {
    if (!Types.ObjectId.isValid(serviceAccountId)) return 0;
    return PersonalAccessToken.countDocuments({
      serviceAccountId: new Types.ObjectId(serviceAccountId), revoked: false, expiresAt: { $gt: new Date() },
    });
  }

  /** Revoke one of an account's keys. Null when it isn't that account's, or is already revoked. */
  async revokeForServiceAccount(serviceAccountId: string, id: string): Promise<AccessKeyView | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(serviceAccountId)) return null;
    const doc = await PersonalAccessToken.findOneAndUpdate(
      { _id: new Types.ObjectId(id), serviceAccountId: new Types.ObjectId(serviceAccountId), revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!doc) return null;
    // Its live exchanged token dies now, everywhere (`revoke:key:<id>`).
    await publishAccessKeyRevocation(id);
    return toView(doc as unknown as PersonalAccessTokenDocument & { _id: unknown });
  }

  /** Delete every key of the given service accounts (account delete). The ORG
   *  purge does its own teardown in `service-account-cascade.ts`, which keeps the
   *  cascade's import graph off the token signer. */
  async deleteForServiceAccounts(serviceAccountIds: readonly Types.ObjectId[]): Promise<number> {
    if (serviceAccountIds.length === 0) return 0;
    const res = await PersonalAccessToken.deleteMany({ serviceAccountId: { $in: serviceAccountIds } });
    return res.deletedCount ?? 0;
  }

  /** Revoke one key by its record id. False when it isn't the user's, or is already revoked. */
  async revoke(userId: string, id: string): Promise<AccessKeyView | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await PersonalAccessToken.findOneAndUpdate(
      { _id: new Types.ObjectId(id), userId, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!doc) return null;
    // The key's live exchanged token (`jti` = key id) dies now, everywhere:
    // platform checks the record; other services read `revoke:key:<id>`.
    await publishAccessKeyRevocation(id);
    return toView(doc as unknown as PersonalAccessTokenDocument & { _id: unknown });
  }

  /**
   * Trade a presented key for a short-lived JWT.
   *
   * Fails CLOSED at every step, and deliberately returns ONE undifferentiated
   * refusal to the caller (the reason is for the audit trail, not the client) so
   * the endpoint can't be used to tell "unknown key" from "revoked key".
   *
   * Re-validated on every exchange, because the token carries no durable
   * authority of its own:
   *   - the key exists, is not revoked and has not expired;
   *   - the user still exists;
   *   - the org the key was minted against still has a LIVE membership for that
   *     user and is not soft-deleted (`membershipForOrg` refuses both).
   * `isSuperAdmin`, role, permissions, tier and features are re-read from the
   * user + org, so a demotion reaches the key within one token lifetime.
   *
   * A `pb_sa_` key takes the SERVICE-ACCOUNT branch below: same record lookup,
   * same revoked/expired checks, then the account's own gates (enabled, org
   * live, IP allowlist, its own exchange budget). `presentedIp` is the address
   * platform sees for this exchange and is what the allowlist is checked against.
   */
  async exchange(rawKey: string, presentedIp?: string): Promise<ExchangeResult> {
    if (!isOpaqueApiKey(rawKey)) return { ok: false, reason: 'malformed' };
    const prefix = apiKeyPrefixOf(rawKey);

    const record = await PersonalAccessToken.findOne({ keyHash: hashApiKey(rawKey) }).lean();
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.revoked) return { ok: false, reason: 'revoked' };
    if (new Date(record.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
    // The prefix and the owner field must AGREE. A record whose shape doesn't
    // match its prefix is not an identity either branch can reason about, so it
    // is refused rather than routed by whichever field happens to be set.
    if (prefix === 'pb_sa' ? !record.serviceAccountId : !record.userId) {
      return { ok: false, reason: 'orphan_key' };
    }

    if (prefix === 'pb_sa') {
      return this.exchangeServiceAccountKey(record, presentedIp);
    }

    const user = await User.findById(record.userId).select('+tokenVersion +isSuperAdmin');
    if (!user) return { ok: false, reason: 'user_gone' };

    let membership;
    if (record.organizationId) {
      membership = await membershipForOrg(String(record.userId), record.organizationId);
      // No live membership (removed / deactivated / ownership moved) or a
      // soft-deleted org: the key's authority is gone. Refuse rather than issue
      // an org-less token that would silently act outside any tenant.
      if (!membership) return { ok: false, reason: 'authority_revoked' };
    }

    const scope = (record.scope ?? undefined) as TokenScope | undefined;
    // The org's assurance rules apply to a key exactly as to a session — the
    // SAME enforcement point (`enforceOrgAssurance`): the org's authenticator
    // allowlist can demote the key's passkey-earned `aal`, and an org that now
    // requires MFA refuses a key created from a single-factor session. A
    // capability-scoped key is the same deliberate carve-out as a scoped
    // machine session.
    let auth: SessionAuth;
    try {
      auth = await enforceOrgAssurance(user, membership, {
        amr: record.amr ?? [],
        aal: record.aal,
        authTime: new Date(record.authTime),
        ...(record.aaguid ? { aaguid: record.aaguid } : {}),
        ...(record.aalAssertedBy ? { aalAssertedBy: record.aalAssertedBy } : {}),
      }, { scope });
    } catch (err) {
      if (err instanceof Error && err.message === MFA_REQUIRED_FOR_ORG) return { ok: false, reason: 'mfa_required' };
      throw err;
    }
    // A permission-scoped key carries subset ∩ the owner's CURRENT permissions
    // in the key's org — re-derived here, on every exchange.
    const permissions = Array.isArray(record.permissions) ? record.permissions : undefined;
    const accessToken = await signApiKeyToken(
      user,
      membership,
      String(record._id),
      auth,
      scope,
      permissions,
    );

    // Last-used is stamped on every exchange (at most once per token lifetime
    // per consumer), so the keys page is accurate no matter which service the
    // key is actually used against.
    void PersonalAccessToken.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } })
      .catch((err) => logger.warn('Failed to stamp access-key lastUsedAt', { error: String(err) }));

    return {
      ok: true,
      accessToken,
      expiresIn: API_KEY_TOKEN_TTL_SECONDS,
      keyId: String(record._id),
      keyName: record.name,
      userId: String(user._id),
      userEmail: user.email,
      principalType: 'user',
      ...(record.organizationId ? { organizationId: record.organizationId } : {}),
      ...(scope ? { scope } : {}),
    };
  }

  /**
   * The SERVICE-ACCOUNT half of {@link exchange} (already past the record's
   * revoked/expired checks).
   *
   * Every gate lives in `service-account-service.resolveServiceAccountExchange`
   * — account enabled, org live, IP allowlist, and the account's OWN
   * token-exchange budget (metered atomically there, so this is also the one
   * place a service account's quota is consumed). Only the token mint and the
   * `lastUsedAt` stamp happen here.
   */
  private async exchangeServiceAccountKey(
    record: PersonalAccessTokenDocument & { _id: unknown },
    presentedIp?: string,
  ): Promise<ExchangeResult> {
    // Lazily imported: service-account-service imports THIS module for its key
    // operations, so a static import would be a cycle. The specifier must be a
    // literal ending in `.js` (Node ESM adds no extensions).
    const { resolveServiceAccountExchange } = await import('./service-account-service.js');
    const resolved = await resolveServiceAccountExchange(
      String(record.serviceAccountId),
      presentedIp,
      record.ipAllowlist,
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const scope = (record.scope ?? undefined) as TokenScope | undefined;
    const accessToken = await signServiceAccountToken(resolved.context, String(record._id), scope);

    void PersonalAccessToken.updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } })
      .catch((err) => logger.warn('Failed to stamp service-account key lastUsedAt', { error: String(err) }));

    return {
      ok: true,
      accessToken,
      expiresIn: API_KEY_TOKEN_TTL_SECONDS,
      keyId: String(record._id),
      keyName: record.name,
      userId: resolved.context.id,
      userEmail: `${resolved.context.name}@service-account.invalid`,
      principalType: 'service_account',
      serviceAccountName: resolved.context.name,
      organizationId: resolved.context.organizationId,
      ...(scope ? { scope } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // SELF-ROTATION (#N2)
  //
  // A machine that holds a key has no browser and no password, so it cannot
  // step up — which is what gates every key write on the org routes. Without a
  // way for a credential to replace ITSELF, an unattended rotator (the AWS
  // token-renew Lambda) would need a second, more powerful credential to manage
  // the first, and the rotation would be no safer than never rotating.
  //
  // So the key IS the authorization, exactly as it is on the exchange, and the
  // authority granted is deliberately the narrowest useful one:
  //   - only a `pb_sa_` key rotates (a person's key has a UI and step-up);
  //   - the new key is a SIBLING on the same account, inheriting the presented
  //     key's scope and IP allowlist — a rotation can never widen authority;
  //   - {@link revokeSibling} refuses to revoke the PRESENTED key, so a rotator
  //     can never destroy the credential it is currently holding.
  // Both run through the same `resolveServiceAccountExchange` gates (and its
  // budget meter) as an ordinary exchange, so a disabled account, a dead org, a
  // disallowed address or an exhausted budget stops rotation too.
  // -------------------------------------------------------------------------

  /** Why a rotate/revoke-sibling was refused. Audited; never told apart to the caller. */
  // (Reuses ExchangeRefusal and adds the two rotation-only reasons.)

  /**
   * Mint a SIBLING key on the account that owns `rawKey`, without touching the
   * presented key. The new key inherits the presented key's scope, IP allowlist
   * and — unless `expiresInSeconds` says otherwise — its original lifetime.
   *
   * The active-key cap is self-healing rather than fatal: at the cap, the OLDEST
   * active key that is NOT the presented one is revoked to make room (reported
   * as `prunedKeyIds`), so a rotator that once failed to revoke its predecessor
   * cannot wedge every future rotation.
   */
  async rotateServiceAccountKey(
    rawKey: string,
    input: { name?: string; expiresInSeconds?: number } = {},
    presentedIp?: string,
  ): Promise<RotateResult> {
    const record = await this.resolveRotationRecord(rawKey);
    if (!record.ok) return record;

    const { resolveServiceAccountExchange, MAX_ACTIVE_KEYS_PER_ACCOUNT, MAX_KEY_EXPIRES_IN_SECONDS } =
      await import('./service-account-service.js');
    const resolved = await resolveServiceAccountExchange(
      String(record.doc.serviceAccountId), presentedIp, record.doc.ipAllowlist,
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    // Lifetime: what the caller asked for, else the ORIGINAL lifetime of the key
    // being replaced (so a 30-day credential stays a 30-day credential without
    // the rotator having to know the number). NEVER longer than that original
    // lifetime: a rotation replaces a credential, it does not upgrade one — a
    // leaked 1-day key must not be able to mint itself a 365-day successor.
    const previousLifetimeSec = Math.round(
      (new Date(record.doc.expiresAt).getTime() - new Date(record.doc.createdAt).getTime()) / 1000,
    );
    const requested = input.expiresInSeconds ?? previousLifetimeSec;
    if (
      !Number.isFinite(requested) || requested < 60
      || requested > MAX_KEY_EXPIRES_IN_SECONDS || requested > previousLifetimeSec
    ) {
      return { ok: false, reason: 'expiry_invalid' };
    }
    const expiresInSeconds = Math.floor(requested);

    // Make room at the cap by retiring the oldest sibling — never the presented
    // key, which must stay live until the caller has stored its replacement.
    const prunedKeyIds: string[] = [];
    const accountId = String(record.doc.serviceAccountId);
    for (;;) {
      const active = await PersonalAccessToken.find({
        serviceAccountId: new Types.ObjectId(accountId), revoked: false, expiresAt: { $gt: new Date() },
      }).sort({ createdAt: 1 }).lean();
      if (active.length < MAX_ACTIVE_KEYS_PER_ACCOUNT) break;
      // Only a PREDECESSOR of the presented key may be retired — the same rule as
      // `revokeSiblingKey`, so a stale key can't clear out its newer siblings.
      const presentedAt = new Date(record.doc.createdAt).getTime();
      const victim = active.find((k) => String(k._id) !== String(record.doc._id)
        && new Date(k.createdAt).getTime() < presentedAt);
      // Nothing older than the presented key is active and we are at the cap:
      // there is nothing safe to retire, so refuse rather than orphan the caller.
      if (!victim) return { ok: false, reason: 'key_limit' };
      await PersonalAccessToken.updateOne({ _id: victim._id }, { $set: { revoked: true, revokedAt: new Date() } });
      await publishAccessKeyRevocation(String(victim._id));
      prunedKeyIds.push(String(victim._id));
    }

    const scope = (record.doc.scope ?? undefined) as TokenScope | undefined;
    const { key, view } = await this.createForServiceAccount({
      serviceAccountId: new Types.ObjectId(accountId),
      organizationId: resolved.context.organizationId,
      name: input.name ?? record.doc.name,
      expiresInSeconds,
      ...(record.doc.ipAllowlist && record.doc.ipAllowlist.length > 0 ? { ipAllowlist: [...record.doc.ipAllowlist] } : {}),
      ...(scope ? { scope } : {}),
    });

    return {
      ok: true,
      key,
      view,
      previousKeyId: String(record.doc._id),
      serviceAccountId: accountId,
      serviceAccountName: resolved.context.name,
      organizationId: resolved.context.organizationId,
      prunedKeyIds,
    };
  }

  /**
   * Revoke `keyId` using a LIVE sibling key of the same service account — the
   * second half of a rotation, once the replacement is safely stored.
   *
   * Refuses to revoke the presented key itself (`self_revoke`): the whole point
   * of the ordering is that the caller always holds a working credential. And
   * only a key's PREDECESSORS are its to retire (`newer_sibling` otherwise): the
   * rotated-in key revokes the one it replaced, never a sibling issued after it
   * — so a stale or leaked older key cannot knock out the account's newer ones.
   */
  async revokeSiblingKey(
    rawKey: string,
    keyId: string,
    presentedIp?: string,
  ): Promise<RevokeSiblingResult> {
    const record = await this.resolveRotationRecord(rawKey);
    if (!record.ok) return record;
    if (!Types.ObjectId.isValid(keyId)) return { ok: false, reason: 'unknown' };
    if (String(record.doc._id) === keyId) return { ok: false, reason: 'self_revoke' };

    const { resolveServiceAccountExchange } = await import('./service-account-service.js');
    const resolved = await resolveServiceAccountExchange(
      String(record.doc.serviceAccountId), presentedIp, record.doc.ipAllowlist,
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };

    const target = await PersonalAccessToken.findOne({
      _id: new Types.ObjectId(keyId),
      serviceAccountId: new Types.ObjectId(String(record.doc.serviceAccountId)),
    }).select('createdAt').lean();
    if (target && new Date(target.createdAt).getTime() >= new Date(record.doc.createdAt).getTime()) {
      return { ok: false, reason: 'newer_sibling' };
    }

    const revoked = await PersonalAccessToken.findOneAndUpdate(
      {
        _id: new Types.ObjectId(keyId),
        serviceAccountId: new Types.ObjectId(String(record.doc.serviceAccountId)),
        revoked: false,
        // Re-asserted in the write: only a predecessor of the presented key.
        createdAt: { $lt: new Date(record.doc.createdAt) },
      },
      { $set: { revoked: true, revokedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (revoked) await publishAccessKeyRevocation(keyId);
    // Already revoked (or never this account's) is IDEMPOTENT success for a
    // rotator: the desired end state — that key cannot be exchanged — holds.
    return {
      ok: true,
      revokedKeyId: keyId,
      alreadyRevoked: !revoked,
      serviceAccountId: String(record.doc.serviceAccountId),
      serviceAccountName: resolved.context.name,
      organizationId: resolved.context.organizationId,
    };
  }

  /**
   * The shared front half of both rotation operations: the presented value is a
   * live, unexpired `pb_sa_` key record. Personal keys are refused here —
   * `not_service_account` — because a person's key is managed in the UI behind
   * step-up, and letting one rotate itself would be a step-up bypass.
   */
  private async resolveRotationRecord(
    rawKey: string,
  ): Promise<{ ok: true; doc: PersonalAccessTokenDocument & { _id: unknown } } | { ok: false; reason: RotationRefusal }> {
    if (!isOpaqueApiKey(rawKey)) return { ok: false, reason: 'malformed' };
    if (apiKeyPrefixOf(rawKey) !== 'pb_sa') return { ok: false, reason: 'not_service_account' };
    const record = await PersonalAccessToken.findOne({ keyHash: hashApiKey(rawKey) }).lean();
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.revoked) return { ok: false, reason: 'revoked' };
    if (new Date(record.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
    if (!record.serviceAccountId) return { ok: false, reason: 'orphan_key' };
    return { ok: true, doc: record as unknown as PersonalAccessTokenDocument & { _id: unknown } };
  }

  /** Revoke every live key a user holds (sign out everywhere, account teardown). */
  async revokeAllForUser(userId: string): Promise<void> {
    const filter = { userId: new Types.ObjectId(String(userId)), revoked: false };
    const live = await PersonalAccessToken.find(filter).select('_id').lean();
    await PersonalAccessToken.updateMany(filter, { $set: { revoked: true, revokedAt: new Date() } });
    await publishAccessKeyRevocation(live.map((k) => String(k._id)));
  }
}

export const apiKeyService = new ApiKeyService();
