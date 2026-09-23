// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin security notifications (docs/plugin-publishing.md "Scan
 * gates"): the org's settings (`plugin_security_notification_prefs`) and the
 * two notices they route —
 *
 *  - **N30** "Plugin version blocked" — a build failed `IMAGE_SCAN_UNAVAILABLE`
 *    or `PLUGIN_VULN_GATE` (nothing was persisted). Always immediate.
 *  - **N31** "Rescan found new Critical/High in x@v" — the nightly rescan found
 *    new findings in a stored version. Honors the org's `digestMode` and
 *    `notifyRescan`; deduplicated per (version, CVE).
 *
 * Recipients are RULES the platform relay resolves at send time: `writers`
 * mode = the uploader (while still a member) + the members holding
 * `plugins:write`; `users` mode = the org's chosen members (only those still
 * active). The org's VERIFIED external address rides along as an `address`
 * rule (the relay admits one on N30/N31 only). The org's webhook is sent here,
 * through api-core's SSRF-safe webhook channel, HMAC-signed
 * (`X-PB-Signature: sha256=…`) when a secret is set.
 *
 * The webhook secret and the external address are stored ENCRYPTED under the
 * org's key and never returned. Setting or changing the address emails a
 * single-use, 24-hour confirmation link to it; the address receives nothing
 * until it is confirmed (`POST /public/plugin-security-notifications/confirm`,
 * which the frontend page `/notifications/confirm` calls from an explicit
 * button, so a mail scanner opening the link can't consume the token).
 *
 * A notice never fails the action that caused it: every send path here
 * catches, logs and counts.
 */

import { createHash, randomBytes } from 'crypto';

import {
  isoOrNull,
  actorId,
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
  assertSafeUrl,
  createLogger,
  createWebhookChannel,
  decryptSecret,
  encryptSecret,
  ErrorCode,
  errorMessage,
  isEncryptedBlob,
  nextEcosystemDigestTime,
  PLUGIN_SECURITY_DIGEST_MODES,
  PLUGIN_SECURITY_RECIPIENT_MODES,
  recordAudit,
  withProposalProvenance,
  describeFindings,
  type EcosystemRecipientSpec,
  type PluginScanFinding,
  type PluginSecurityDigestMode,
  type PluginSecurityRecipientMode,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { schema, type PluginSecurityNotificationPref } from '@pipeline-builder/pipeline-data';
import { eq, inArray } from 'drizzle-orm';

import { EcosystemError } from './ecosystem/context.js';
import { elevated } from './ecosystem/store.js';
import { frontendBaseUrl } from './ecosystem/submission-config.js';
import { enqueueEcosystemNotification, type EnqueueOptions, type EnqueueOutcome } from './ecosystem-notifications.js';

const logger = createLogger('plugin-security-notifications');

/** How long an external-address confirmation link stays valid. */
export const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
/** At most this many chosen recipients (the relay's `org_members` cap). */
export const MAX_TARGET_USERS = 100;
/** How long a notified (version, CVE) pair is remembered for N31 dedupe. */
export const N31_DEDUPE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

/** The stored settings as the service reads them (defaults for an absent row). */
export interface SecurityPrefs {
  orgId: string;
  recipientMode: PluginSecurityRecipientMode;
  targetUsers: string[];
  notifyRescan: boolean;
  digestMode: PluginSecurityDigestMode;
  webhookUrl: string | null;
  webhookSecret: string | null;
  externalEmailEnc: string | null;
  externalEmailHash: string | null;
  externalEmailVerifiedAt: Date | null;
  externalVerifyTokenHash: string | null;
  externalVerifyExpiresAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** The column defaults (an org with no row). */
export function defaultPrefs(orgId: string): SecurityPrefs {
  return {
    orgId,
    recipientMode: 'writers',
    targetUsers: [],
    notifyRescan: true,
    digestMode: 'immediate',
    webhookUrl: null,
    webhookSecret: null,
    externalEmailEnc: null,
    externalEmailHash: null,
    externalEmailVerifiedAt: null,
    externalVerifyTokenHash: null,
    externalVerifyExpiresAt: null,
    updatedBy: null,
    updatedAt: null,
  };
}

function fromRow(orgId: string, row: PluginSecurityNotificationPref | null | undefined): SecurityPrefs {
  if (!row) return defaultPrefs(orgId);
  return {
    orgId,
    recipientMode: row.recipientMode,
    targetUsers: row.targetUsers ?? [],
    notifyRescan: row.notifyRescan,
    digestMode: row.digestMode,
    webhookUrl: row.webhookUrl ?? null,
    webhookSecret: row.webhookSecret ?? null,
    externalEmailEnc: row.externalEmailEnc ?? null,
    externalEmailHash: row.externalEmailHash ?? null,
    externalEmailVerifiedAt: row.externalEmailVerifiedAt ?? null,
    externalVerifyTokenHash: row.externalVerifyTokenHash ?? null,
    externalVerifyExpiresAt: row.externalVerifyExpiresAt ?? null,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

const T = () => schema.pluginSecurityNotificationPref;

/** Data access (elevated, like the rest of the plugin ecosystem store: every call names its org). */
export const prefsStore = {
  async get(orgId: string): Promise<SecurityPrefs> {
    const rows = await elevated((tx) => tx.select().from(T()).where(eq(T().orgId, orgId))) as PluginSecurityNotificationPref[];
    return fromRow(orgId, rows[0]);
  },
  async many(orgIds: string[]): Promise<Map<string, SecurityPrefs>> {
    const unique = [...new Set(orgIds)];
    const rows = unique.length === 0 ? [] : await elevated((tx) => tx.select().from(T()).where(inArray(T().orgId, unique))) as PluginSecurityNotificationPref[];
    return new Map(unique.map((o) => [o, fromRow(o, rows.find((r) => r.orgId === o))]));
  },
  async byVerifyToken(tokenHash: string): Promise<SecurityPrefs | null> {
    const rows = await elevated((tx) => tx.select().from(T()).where(eq(T().externalVerifyTokenHash, tokenHash))) as PluginSecurityNotificationPref[];
    return rows[0] ? fromRow(rows[0].orgId, rows[0]) : null;
  },
  async put(prefs: SecurityPrefs): Promise<void> {
    const { orgId, updatedAt: _ignored, ...values } = prefs;
    const now = new Date();
    await elevated(async (tx) => {
      const existing = await tx.select({ orgId: T().orgId }).from(T()).where(eq(T().orgId, orgId)) as Array<{ orgId: string }>;
      if (existing.length > 0) {
        await tx.update(T()).set({ ...values, updatedAt: now }).where(eq(T().orgId, orgId));
      } else {
        await tx.insert(T()).values({ orgId, ...values, updatedAt: now });
      }
    });
  },
};

/** `a***@example.com` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** The org's external address, decrypted, or null when there is none / it can't be read. */
async function externalEmailOf(prefs: SecurityPrefs): Promise<string | null> {
  if (!prefs.externalEmailEnc) return null;
  try {
    const blob: unknown = JSON.parse(prefs.externalEmailEnc);
    return isEncryptedBlob(blob) ? await decryptSecret(blob, prefs.orgId) : null;
  } catch (err) {
    logger.warn('External security address unreadable', { orgId: prefs.orgId, error: errorMessage(err) });
    return null;
  }
}

/** The org's VERIFIED external address, or null (unverified addresses never receive notices). */
export async function verifiedExternalEmail(prefs: SecurityPrefs): Promise<string | null> {
  return prefs.externalEmailVerifiedAt ? externalEmailOf(prefs) : null;
}

async function webhookSecretOf(prefs: SecurityPrefs): Promise<string | undefined> {
  if (!prefs.webhookSecret) return undefined;
  try {
    const blob: unknown = JSON.parse(prefs.webhookSecret);
    return isEncryptedBlob(blob) ? await decryptSecret(blob, prefs.orgId) : undefined;
  } catch (err) {
    logger.warn('Plugin security webhook secret unreadable; sending unsigned', { orgId: prefs.orgId, error: errorMessage(err) });
    return undefined;
  }
}

/** The settings as the API returns them: never the secret, never the address. */
export async function toApiPrefs(prefs: SecurityPrefs, canEdit: boolean) {
  const email = await externalEmailOf(prefs);
  return {
    recipientMode: prefs.recipientMode,
    targetUsers: prefs.targetUsers,
    notifyRescan: prefs.notifyRescan,
    digestMode: prefs.digestMode,
    webhookUrl: prefs.webhookUrl,
    hasWebhookSecret: !!prefs.webhookSecret,
    externalEmail: email
      ? {
        masked: maskEmail(email),
        verified: prefs.externalEmailVerifiedAt !== null,
        pendingExpiresAt: prefs.externalEmailVerifiedAt === null ? isoOrNull(prefs.externalVerifyExpiresAt) : null,
      }
      : null,
    updatedBy: prefs.updatedBy,
    updatedAt: isoOrNull(prefs.updatedAt),
    canEdit,
  };
}

export type ApiSecurityPrefs = Awaited<ReturnType<typeof toApiPrefs>>;

/** The validated `PUT` body. */
export interface PrefsUpdate {
  recipientMode?: PluginSecurityRecipientMode;
  targetUsers?: string[];
  notifyRescan?: boolean;
  digestMode?: PluginSecurityDigestMode;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  externalEmail?: string | null;
  resendConfirmation?: boolean;
}

const FIELDS: ReadonlyArray<keyof PrefsUpdate> = [
  'recipientMode', 'targetUsers', 'notifyRescan', 'digestMode', 'webhookUrl', 'webhookSecret', 'externalEmail', 'resendConfirmation',
];

/** Validate a `PUT` body (strict: unknown fields are refused). Throws a 400. */
export function parsePrefsUpdate(body: unknown): PrefsUpdate {
  const bad = (message: string): never => { throw new EcosystemError(ErrorCode.VALIDATION_ERROR, message); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be an object');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) bad(`unknown field(s): ${unknown.join(', ')}`);
  const out: PrefsUpdate = {};
  if (b.recipientMode !== undefined) {
    if (!(PLUGIN_SECURITY_RECIPIENT_MODES as readonly unknown[]).includes(b.recipientMode)) bad(`recipientMode must be one of ${PLUGIN_SECURITY_RECIPIENT_MODES.join(', ')}`);
    out.recipientMode = b.recipientMode as PluginSecurityRecipientMode;
  }
  if (b.targetUsers !== undefined) {
    if (!Array.isArray(b.targetUsers) || !b.targetUsers.every((u) => typeof u === 'string' && u.trim() !== '' && u.length <= 128)) bad('targetUsers must be an array of user ids');
    const users = [...new Set((b.targetUsers as string[]).map((u) => u.trim()))];
    if (users.length > MAX_TARGET_USERS) bad(`at most ${MAX_TARGET_USERS} targetUsers`);
    out.targetUsers = users;
  }
  if (b.notifyRescan !== undefined) {
    if (typeof b.notifyRescan !== 'boolean') bad('notifyRescan must be a boolean');
    out.notifyRescan = b.notifyRescan as boolean;
  }
  if (b.digestMode !== undefined) {
    if (!(PLUGIN_SECURITY_DIGEST_MODES as readonly unknown[]).includes(b.digestMode)) bad(`digestMode must be one of ${PLUGIN_SECURITY_DIGEST_MODES.join(', ')}`);
    out.digestMode = b.digestMode as PluginSecurityDigestMode;
  }
  if (b.webhookUrl !== undefined) {
    if (b.webhookUrl === null || b.webhookUrl === '') out.webhookUrl = null;
    else if (typeof b.webhookUrl !== 'string' || b.webhookUrl.length > 2048 || !b.webhookUrl.startsWith('https://')) bad('webhookUrl must be an https URL');
    else out.webhookUrl = b.webhookUrl;
  }
  if (b.webhookSecret !== undefined) {
    if (b.webhookSecret === null || b.webhookSecret === '') out.webhookSecret = null;
    else if (typeof b.webhookSecret !== 'string' || b.webhookSecret.length > 512) bad('webhookSecret must be a string (at most 512 characters)');
    else out.webhookSecret = b.webhookSecret;
  }
  if (b.externalEmail !== undefined) {
    if (b.externalEmail === null || b.externalEmail === '') {out.externalEmail = null;} else {
      const email = typeof b.externalEmail === 'string' ? b.externalEmail.trim().toLowerCase() : '';
      if (email.length > 320 || !EMAIL_SHAPE.test(email)) bad('externalEmail must be an email address');
      out.externalEmail = email;
    }
  }
  if (b.resendConfirmation !== undefined) {
    if (typeof b.resendConfirmation !== 'boolean') bad('resendConfirmation must be a boolean');
    out.resendConfirmation = b.resendConfirmation as boolean;
  }
  return out;
}

/** `/notifications/confirm?token=…` on the frontend. */
export const confirmUrl = (token: string): string => `${frontendBaseUrl()}/notifications/confirm?token=${encodeURIComponent(token)}`;

/** Email the single-use confirmation link to an external address (N30 transport, address recipient). */
async function sendConfirmation(email: string, token: string): Promise<void> {
  try {
    await enqueueEcosystemNotification('N30', [{ kind: 'address', email }], {
      subject: 'Confirm this address for plugin security notices',
      text: 'Someone set this address to receive plugin security notices (blocked plugin builds and new vulnerability '
        + 'findings) for their Pipeline Builder organization.\n\n'
        + `Confirm within 24 hours: ${confirmUrl(token)}\n\n`
        + 'The link opens a page with a Confirm button. If you did not expect this, ignore it: nothing is sent to an unconfirmed address.',
    }, { immediate: true });
  } catch (err) {
    incCounter('plugin_security_notification_failed_total', { event: 'confirm' });
    logger.warn('External address confirmation not sent', { error: errorMessage(err) });
  }
}

/** `GET /plugins/security-notifications`. */
export async function getSecurityPrefs(orgId: string, canEdit: boolean): Promise<ApiSecurityPrefs> {
  return toApiPrefs(await prefsStore.get(orgId), canEdit);
}

/**
 * `PUT /plugins/security-notifications` — validated, stored, audited; a new/changed
 * address gets a confirmation link.
 *
 * `headers` is the request's header bag, and is read for ONE thing: the Ask
 * panel's provenance marker, which the audit event records as
 * `proposedBy: 'ask-agent'`. The route gates it with `proposable`, so a header
 * claiming any other proposer never reaches here; omitting it (as the service's
 * own tests do) simply records no provenance.
 */
export async function putSecurityPrefs(orgId: string, userId: string, body: unknown, headers?: unknown): Promise<ApiSecurityPrefs> {
  const update = parsePrefsUpdate(body);
  const before = await prefsStore.get(orgId);
  const next: SecurityPrefs = { ...before, updatedBy: userId };
  if (update.recipientMode !== undefined) next.recipientMode = update.recipientMode;
  if (update.targetUsers !== undefined) next.targetUsers = update.targetUsers;
  if (update.notifyRescan !== undefined) next.notifyRescan = update.notifyRescan;
  if (update.digestMode !== undefined) next.digestMode = update.digestMode;
  if (next.recipientMode === 'users' && next.targetUsers.length === 0) {
    throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'recipientMode "users" needs at least one user in targetUsers');
  }
  if (update.webhookUrl !== undefined) {
    if (update.webhookUrl) {
      try {
        await assertSafeUrl(update.webhookUrl);
      } catch (err) {
        throw new EcosystemError(ErrorCode.VALIDATION_ERROR, `webhookUrl is not allowed: ${errorMessage(err)}`);
      }
    }
    next.webhookUrl = update.webhookUrl;
    // A cleared webhook takes its secret with it.
    if (!update.webhookUrl) next.webhookSecret = null;
  }
  if (update.webhookSecret !== undefined) {
    next.webhookSecret = update.webhookSecret ? JSON.stringify(await encryptSecret(update.webhookSecret, orgId)) : null;
  }

  // The address to (re)send a confirmation link to, if any.
  let confirmTo: string | null = null;
  if (update.externalEmail !== undefined) {
    if (update.externalEmail === null) {
      Object.assign(next, { externalEmailEnc: null, externalEmailHash: null, externalEmailVerifiedAt: null, externalVerifyTokenHash: null, externalVerifyExpiresAt: null });
    } else if (sha256(update.externalEmail) !== before.externalEmailHash) {
      // A new address starts unverified, whatever was confirmed before.
      next.externalEmailEnc = JSON.stringify(await encryptSecret(update.externalEmail, orgId));
      next.externalEmailHash = sha256(update.externalEmail);
      next.externalEmailVerifiedAt = null;
      confirmTo = update.externalEmail;
    }
  }
  if (update.resendConfirmation && confirmTo === null && next.externalEmailEnc && !next.externalEmailVerifiedAt) {
    confirmTo = await externalEmailOf(next);
  }
  let token: string | null = null;
  if (confirmTo !== null) {
    token = randomBytes(32).toString('base64url');
    next.externalVerifyTokenHash = sha256(token);
    next.externalVerifyExpiresAt = new Date(Date.now() + CONFIRM_TTL_MS);
  }

  await prefsStore.put(next);
  if (confirmTo !== null && token !== null) await sendConfirmation(confirmTo, token);

  const changed = FIELDS.filter((k) => k !== 'resendConfirmation' && update[k] !== undefined);
  recordAudit({
    action: 'plugin.security_notifications.update',
    actorId: actorId({ userId }),
    orgId,
    targetType: 'plugin-security-notifications',
    targetId: orgId,
    details: withProposalProvenance(headers, {
      // Field NAMES and the webhook host only — never the secret, never the address.
      fields: changed,
      recipientMode: next.recipientMode,
      targetUserCount: next.targetUsers.length,
      digestMode: next.digestMode,
      notifyRescan: next.notifyRescan,
      webhookHost: hostOf(next.webhookUrl),
      webhookSecretSet: !!next.webhookSecret,
      externalEmailSet: !!next.externalEmailEnc,
      confirmationSent: token !== null,
    }),
  });
  return toApiPrefs(await prefsStore.get(orgId), true);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

/**
 * `POST /public/plugin-security-notifications/confirm` — consume a single-use
 * confirmation token: the address becomes verified. An unknown, used or
 * expired token is a 400 (the same answer for each: no oracle).
 */
export async function confirmExternalEmail(rawToken: unknown): Promise<{ confirmed: true }> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const invalid = () => new EcosystemError(ErrorCode.VALIDATION_ERROR, 'This confirmation link is invalid or has expired.');
  if (token.length < 16 || token.length > 128) throw invalid();
  const prefs = await prefsStore.byVerifyToken(sha256(token));
  if (!prefs || !prefs.externalVerifyExpiresAt || prefs.externalVerifyExpiresAt.getTime() <= Date.now() || !prefs.externalEmailEnc) throw invalid();
  await prefsStore.put({ ...prefs, externalEmailVerifiedAt: new Date(), externalVerifyTokenHash: null, externalVerifyExpiresAt: null });
  recordAudit({
    action: 'plugin.security_notifications.external_email.verify',
    actorId: ANONYMOUS_ACTOR_ID,
    orgId: prefs.orgId,
    targetType: 'plugin-security-notifications',
    targetId: prefs.orgId,
    details: { confirmed: true },
  });
  return { confirmed: true };
}

// -----------------------------------------------------------------------------
// Delivery
// -----------------------------------------------------------------------------

/** Recipient rules for an org's notice (see the module doc). */
export async function recipientsFor(prefs: SecurityPrefs, uploaderId?: string | null): Promise<EcosystemRecipientSpec[]> {
  const orgId = prefs.orgId;
  const rules: EcosystemRecipientSpec[] = [];
  if (prefs.recipientMode === 'users' && prefs.targetUsers.length > 0) {
    rules.push({ kind: 'org_members', orgId, userIds: prefs.targetUsers.slice(0, MAX_TARGET_USERS) });
  } else {
    rules.push({ kind: 'org_permission', orgId, permission: 'plugins:write' });
    if (uploaderId && uploaderId !== SYSTEM_ACTOR_ID) rules.push({ kind: 'org_members', orgId, userIds: [uploaderId] });
  }
  const email = await verifiedExternalEmail(prefs);
  if (email) rules.push({ kind: 'address', email });
  return rules;
}

/** What a security webhook receives. */
export interface SecurityWebhookPayload {
  event: 'N30' | 'N31' | 'test';
  type: 'plugin.version.blocked' | 'plugin.rescan.findings' | 'plugin.security_notifications.test';
  orgId: string;
  plugin: string | null;
  version: string | null;
  subject: string;
  text: string;
  code?: string;
  critical?: number;
  high?: number;
  findings?: PluginScanFinding[];
  occurredAt: string;
}

/** Sends one webhook; swappable in tests (the live one is SSRF-safe and signed). */
export type SecurityWebhookSender = (url: string, secret: string | undefined, payload: SecurityWebhookPayload) => Promise<{ ok: boolean; code?: number; error?: string }>;

const liveWebhook = createWebhookChannel({ name: 'plugin-security-webhook', timeoutMs: 10_000 });
const liveWebhookSender: SecurityWebhookSender = (url, secret, payload) => liveWebhook.deliver({
  recipientOrgId: payload.orgId,
  subject: payload.subject,
  body: payload.text,
  priority: 'high',
  messageType: 'announcement',
  payload,
}, { value: url, ...(secret ? { secret } : {}) });

let webhookSender: SecurityWebhookSender = liveWebhookSender;

/** Test hook: swap the webhook sender (nothing restores the live one). */
export function setSecurityWebhookSenderForTests(sender?: SecurityWebhookSender): void {
  webhookSender = sender ?? liveWebhookSender;
}

async function sendWebhook(prefs: SecurityPrefs, payload: SecurityWebhookPayload): Promise<{ ok: boolean; code?: number; error?: string } | null> {
  if (!prefs.webhookUrl) return null;
  try {
    const result = await webhookSender(prefs.webhookUrl, await webhookSecretOf(prefs), payload);
    incCounter('plugin_security_webhooks_total', { event: payload.event, outcome: result.ok ? 'delivered' : 'failed' });
    if (!result.ok) logger.warn('Plugin security webhook not delivered', { orgId: prefs.orgId, event: payload.event, code: result.code, error: result.error });
    return result;
  } catch (err) {
    incCounter('plugin_security_webhooks_total', { event: payload.event, outcome: 'failed' });
    logger.warn('Plugin security webhook threw', { orgId: prefs.orgId, event: payload.event, error: errorMessage(err) });
    return { ok: false, error: errorMessage(err) };
  }
}

async function sendRelay(event: 'N30' | 'N31', recipients: EcosystemRecipientSpec[], content: { subject: string; text: string }, opts: EnqueueOptions): Promise<EnqueueOutcome | 'failed'> {
  try {
    return await enqueueEcosystemNotification(event, recipients, { subject: content.subject.slice(0, 500), text: content.text.slice(0, 10_000) }, opts);
  } catch (err) {
    incCounter('plugin_security_notification_failed_total', { event });
    logger.warn('Plugin security notice not sent', { event, error: errorMessage(err) });
    return 'failed';
  }
}

/** A blocked version (N30). */
export interface BlockedVersionNotice {
  orgId: string;
  uploaderId?: string | null;
  plugin: string;
  version: string;
  /** `IMAGE_SCAN_UNAVAILABLE` or `PLUGIN_VULN_GATE`. */
  code: string;
  message: string;
  critical?: number;
  high?: number;
  findings?: PluginScanFinding[];
}

/** N30: a build was blocked by a platform scan gate. Immediate, every configured channel. Never throws. */
export async function notifyVersionBlocked(n: BlockedVersionNotice): Promise<void> {
  try {
    const prefs = await prefsStore.get(n.orgId);
    const ref = `${n.plugin}@${n.version}`;
    const why = n.code === 'IMAGE_SCAN_UNAVAILABLE'
      ? 'its image could not be vulnerability-scanned'
      : `its image has ${n.critical ?? 0} fixable Critical finding${n.critical === 1 ? '' : 's'}`;
    const subject = `Plugin version blocked: ${ref}`;
    const text = `The build of ${ref} was blocked because ${why}; nothing was saved.\n\n${n.message}`
      + (n.findings?.length ? `\n\nFix: ${describeFindings(n.findings, 10)}` : '');
    await sendRelay('N30', await recipientsFor(prefs, n.uploaderId), { subject, text }, { immediate: true });
    await sendWebhook(prefs, {
      event: 'N30',
      type: 'plugin.version.blocked',
      orgId: n.orgId,
      plugin: n.plugin,
      version: n.version,
      subject,
      text,
      code: n.code,
      ...(n.critical !== undefined ? { critical: n.critical } : {}),
      ...(n.high !== undefined ? { high: n.high } : {}),
      ...(n.findings ? { findings: n.findings } : {}),
      occurredAt: new Date().toISOString(),
    });
    incCounter('plugin_security_notifications_total', { event: 'N30' });
  } catch (err) {
    incCounter('plugin_security_notification_failed_total', { event: 'N30' });
    logger.warn('Blocked-version notice failed', { orgId: n.orgId, plugin: n.plugin, error: errorMessage(err) });
  }
}

/** Remembers which (version, finding) pairs were already notified (N31). */
export interface NoticeDedupeStore {
  /** The members of `members` not seen before under `key` (and remembers them). Throws when the store is down. */
  claimNew(key: string, members: readonly string[], ttlMs: number): Promise<string[]>;
}

const redisDedupe: NoticeDedupeStore = {
  async claimNew(key, members, ttlMs) {
    const { getHealthRedisConnection } = await import('../queue/connections.js');
    const redis = getHealthRedisConnection();
    const fresh: string[] = [];
    for (const m of members) {
      if (await redis.sadd(key, m) === 1) fresh.push(m);
    }
    if (members.length > 0) await redis.pexpire(key, ttlMs);
    return fresh;
  },
};

let dedupe: NoticeDedupeStore = redisDedupe;

/** Test hook: replace the dedupe store (pass nothing to restore Redis). */
export function setNoticeDedupeStoreForTests(store?: NoticeDedupeStore): void {
  dedupe = store ?? redisDedupe;
}

/** One rescanned version with new findings (N31). */
export interface RescanFindingsNotice {
  /** Stable version identity for dedupe: `plugin:<id>` or `listing-version:<id>`. */
  versionKey: string;
  plugin: string;
  version: string;
  critical: number;
  high: number;
  /** Critical/high findings of the rescan (fixable ones carry `fixedIn`). */
  findings: PluginScanFinding[];
  /** Whether this rescan flagged the version (fixable criticals over the floor). */
  flagged: boolean;
  /** The orgs to tell, each with the uploader to include (tenant rows) or none (installing orgs). */
  orgs: Array<{ orgId: string; uploaderId?: string | null }>;
}

/**
 * N31: the rescan found new critical/high findings in a version. Deduplicated
 * per (version, finding) — a finding already notified for this version is never
 * notified again (the store fails OPEN: a duplicate beats a lost notice). Each
 * org's `notifyRescan` and `digestMode` apply. Returns the orgs notified; never throws.
 */
export async function notifyRescanFindings(n: RescanFindingsNotice): Promise<number> {
  try {
    const keys = n.findings.map((f) => `${f.id}|${f.packageName}`);
    if (keys.length === 0 || n.orgs.length === 0) return 0;
    let fresh: string[];
    try {
      fresh = await dedupe.claimNew(`plugin-security:n31:${n.versionKey}`, keys, N31_DEDUPE_TTL_MS);
    } catch (err) {
      logger.warn('N31 dedupe store unavailable; notifying anyway', { versionKey: n.versionKey, error: errorMessage(err) });
      fresh = keys;
    }
    if (fresh.length === 0) {
      incCounter('plugin_security_notifications_deduplicated_total', { event: 'N31' });
      return 0;
    }
    const newFindings = n.findings.filter((f) => fresh.includes(`${f.id}|${f.packageName}`));
    const ref = `${n.plugin}@${n.version}`;
    const subject = `Rescan found new Critical/High in plugin ${ref}`;
    const fixable = newFindings.filter((f) => f.fixedIn.length > 0);
    const text = `The nightly vulnerability rescan found ${newFindings.length} new critical/high finding${newFindings.length === 1 ? '' : 's'} in ${ref} `
      + `(now ${n.critical} critical, ${n.high} high).`
      + (n.flagged ? ' The version is FLAGGED: it has fixable Critical findings above the platform limit — rebuild it on patched packages or upgrade.' : '')
      + `\n\n${describeFindings(newFindings, 10)}`
      + (fixable.length ? '\n\nRebuilding on the fixed package versions clears the flag at the next rescan.' : '');
    const prefsByOrg = await prefsStore.many(n.orgs.map((o) => o.orgId));
    let notified = 0;
    for (const target of n.orgs) {
      const prefs = prefsByOrg.get(target.orgId) ?? defaultPrefs(target.orgId);
      if (!prefs.notifyRescan) continue;
      const opts: EnqueueOptions = prefs.digestMode === 'immediate'
        ? { immediate: true }
        : { deliverAfter: nextEcosystemDigestTime(prefs.digestMode), digestKey: `N31:${target.orgId}` };
      await sendRelay('N31', await recipientsFor(prefs, target.uploaderId), { subject, text }, opts);
      await sendWebhook(prefs, {
        event: 'N31',
        type: 'plugin.rescan.findings',
        orgId: target.orgId,
        plugin: n.plugin,
        version: n.version,
        subject,
        text,
        critical: n.critical,
        high: n.high,
        findings: newFindings,
        occurredAt: new Date().toISOString(),
      });
      notified++;
    }
    incCounter('plugin_security_notifications_total', { event: 'N31' }, notified);
    return notified;
  } catch (err) {
    incCounter('plugin_security_notification_failed_total', { event: 'N31' });
    logger.warn('Rescan-findings notice failed', { versionKey: n.versionKey, error: errorMessage(err) });
    return 0;
  }
}

/** What `POST /plugins/security-notifications/test` did per channel. */
export interface TestSendResult {
  /** The relay (in-app + email to the resolved recipients). */
  relay: EnqueueOutcome | 'failed';
  /** The webhook, when one is configured. */
  webhook: { ok: boolean; code?: number; error?: string } | null;
  /** The external address: sent (verified), pending (not confirmed — not sent) or none. */
  externalEmail: 'sent' | 'pending' | 'none';
}

/** `POST /plugins/security-notifications/test` — one test notice on every configured channel, audited. */
export async function sendTestNotice(orgId: string, userId: string): Promise<TestSendResult> {
  const prefs = await prefsStore.get(orgId);
  const subject = 'Test: plugin security notifications';
  const text = 'This is a test of your organization\'s plugin security notifications. Real notices tell you when a plugin '
    + 'version is blocked (it could not be scanned, or has fixable Critical vulnerabilities) and when the nightly rescan '
    + 'finds new Critical/High vulnerabilities in a stored version.';
  const recipients = await recipientsFor(prefs, userId);
  const relay = await sendRelay('N30', recipients, { subject, text }, { immediate: true });
  const webhook = await sendWebhook(prefs, {
    event: 'test', type: 'plugin.security_notifications.test', orgId, plugin: null, version: null, subject, text, occurredAt: new Date().toISOString(),
  });
  const externalEmail: TestSendResult['externalEmail'] = recipients.some((r) => r.kind === 'address')
    ? 'sent' : prefs.externalEmailEnc ? 'pending' : 'none';
  recordAudit({
    action: 'plugin.security_notifications.test',
    actorId: actorId({ userId }),
    orgId,
    targetType: 'plugin-security-notifications',
    targetId: orgId,
    details: { relay, webhook: webhook ? (webhook.ok ? 'delivered' : 'failed') : 'none', externalEmail },
  });
  return { relay, webhook, externalEmail };
}
