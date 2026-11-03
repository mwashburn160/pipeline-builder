// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin security notifications (docs/plugin-publishing.md "Scan
 * gates"): the org's settings (`plugin_security_notification_prefs`) and the
 * notices they route —
 *
 *  - **N30** "Plugin version blocked" — a build failed `IMAGE_SCAN_UNAVAILABLE`
 *    or `PLUGIN_VULN_GATE` (nothing was persisted). Always immediate.
 *  - **N31** "Rescan found new Critical/High in x@v" — the nightly rescan found
 *    new findings in a stored version (or a known one was newly listed on CISA
 *    KEV). Honors the org's `digestMode` and `notifyRescan`; deduplicated per
 *    (version, CVE, KEV status). When the org's pipelines run the version, the
 *    org's pipeline writers hear it too, step by step, with the version to move
 *    to (`notifyPipelineOwners`).
 *  - **N32** "Pipeline running a vulnerable plugin" — a lookup or runtime check
 *    graded a pipeline's plugin version `error` or louder (flagged, fixable
 *    Critical, KEV, a failing block-mode compliance rule). Vulnerability state
 *    never stops a pipeline; this notice is how its owners learn. Immediate;
 *    deduplicated per (pipeline, version) per 24 hours.
 *  - **N33** "Risk acceptance lapsed" — a pipeline's time-boxed acceptance of a
 *    version's findings passed its deadline; the findings are live again.
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
  failOnLabel,
  type EcosystemRecipientSpec,
  type PluginScanFinding,
  type PluginSecurityDigestMode,
  type PluginSecurityRecipientMode,
  type VulnSeverity,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { pipelinesOnVersion, runWithTenantContext, schema, type PipelineOnVersion, type PluginSecurityNotificationPref } from '@pipeline-builder/pipeline-data';
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
/** How long a (pipeline, version) block is remembered for N32 dedupe. */
export const N32_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** The org's pipeline writers hear about the versions their pipelines run (N31 paragraph, N32, N33). */
  notifyPipelineOwners: boolean;
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
    notifyPipelineOwners: true,
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
    notifyPipelineOwners: row.notifyPipelineOwners,
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
    notifyPipelineOwners: prefs.notifyPipelineOwners,
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
  notifyPipelineOwners?: boolean;
  digestMode?: PluginSecurityDigestMode;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  externalEmail?: string | null;
  resendConfirmation?: boolean;
}

const FIELDS: ReadonlyArray<keyof PrefsUpdate> = [
  'recipientMode', 'targetUsers', 'notifyRescan', 'notifyPipelineOwners', 'digestMode', 'webhookUrl', 'webhookSecret', 'externalEmail', 'resendConfirmation',
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
  if (b.notifyPipelineOwners !== undefined) {
    if (typeof b.notifyPipelineOwners !== 'boolean') bad('notifyPipelineOwners must be a boolean');
    out.notifyPipelineOwners = b.notifyPipelineOwners as boolean;
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
  if (update.notifyPipelineOwners !== undefined) next.notifyPipelineOwners = update.notifyPipelineOwners;
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
      notifyPipelineOwners: next.notifyPipelineOwners,
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

/** The org's PIPELINE writers (pipelines:write holders), plus its verified external address. */
export async function pipelineOwnerRecipients(prefs: SecurityPrefs): Promise<EcosystemRecipientSpec[]> {
  const rules: EcosystemRecipientSpec[] = [{ kind: 'org_permission', orgId: prefs.orgId, permission: 'pipelines:write' }];
  const email = await verifiedExternalEmail(prefs);
  if (email) rules.push({ kind: 'address', email });
  return rules;
}

/** What a security webhook receives. */
export interface SecurityWebhookPayload {
  event: 'N30' | 'N31' | 'N32' | 'N33' | 'test';
  type: 'plugin.version.blocked' | 'plugin.rescan.findings' | 'pipeline.plugin.vulnerable' | 'pipeline.vuln.acceptance_lapsed' | 'plugin.security_notifications.test';
  orgId: string;
  plugin: string | null;
  version: string | null;
  subject: string;
  text: string;
  code?: string;
  critical?: number;
  high?: number;
  findings?: PluginScanFinding[];
  /** N31: the rescanned image, when the notice names one. */
  imageDigest?: string;
  /** N31: the receiving org's pipelines declaring or running the version, with the steps on it. */
  affectedPipelines?: Array<{ id: string; name: string | null; source: 'declared' | 'deployed'; imageDigest: string | null; steps: string[] }>;
  /** N31: one of the findings is newly on CISA KEV. */
  kevNew?: boolean;
  /** N31 / N32: the newest version the owner can move to, when known. */
  suggestedVersion?: string;
  /** N32: the pipeline and step, the loudest severity and the warnings at `error` or louder. */
  pipeline?: { id: string; name: string | null };
  stepKey?: string;
  severity?: VulnSeverity;
  warnings?: Array<{ code: string; severity: VulnSeverity; message: string }>;
  trigger?: 'lookup' | 'runtime-check' | 'removal';
  /** N33: the acceptances that lapsed. */
  acceptances?: Array<{ exposureId: string; pipelineId: string; plugin: string; version: string; imageDigest: string | null; acceptedUntil: string | null; triagedBy: string | null; reason: string | null }>;
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

async function sendRelay(event: 'N30' | 'N31' | 'N32' | 'N33', recipients: EcosystemRecipientSpec[], content: { subject: string; text: string }, opts: EnqueueOptions): Promise<EnqueueOutcome | 'failed'> {
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
  /** `PLUGIN_VULN_GATE`: findings at or above `failOn` that broke the floor. */
  gated?: number;
  /** The `PLUGIN_VULN_FAIL_ON` the gate ran at, when `high`; absent = `critical`. */
  failOn?: 'high';
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
      : `its image has ${n.gated ?? 0} fixable ${failOnLabel(n.failOn ?? 'critical')} finding${n.gated === 1 ? '' : 's'}`;
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
      ...(n.gated !== undefined ? { gated: n.gated } : {}),
      ...(n.failOn ? { failOn: n.failOn } : {}),
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
  /**
   * The rescanned image. When given, the affected pipelines named in each org's
   * notice are the ones on THIS image (a version rebuilt on a patched base under
   * the same version string is not affected); omitted = any image of the version.
   */
  imageDigest?: string | null;
  /** The orgs to tell, each with the uploader to include (tenant rows) or none (installing orgs). */
  orgs: Array<{ orgId: string; uploaderId?: string | null }>;
  /** The newest unflagged version pipeline owners can move to, when known. */
  suggestedVersion?: string | null;
}

/** A finding's N31 dedupe member: its identity, plus its KEV status so a newly-listed KEV re-notifies. */
const n31Member = (f: PluginScanFinding): string => `${f.id}|${f.packageName}${f.kev === true ? '|kev' : ''}`;

/**
 * N31: the rescan found new critical/high findings in a version. Deduplicated
 * per (version, finding) — a finding already notified for this version is never
 * notified again (the store fails OPEN: a duplicate beats a lost notice). Each
 * org's `notifyRescan` and `digestMode` apply. Returns the orgs notified; never throws.
 */
export async function notifyRescanFindings(n: RescanFindingsNotice): Promise<number> {
  try {
    const keys = n.findings.map(n31Member);
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
    const newFindings = n.findings.filter((f) => fresh.includes(n31Member(f)));
    const ref = `${n.plugin}@${n.version}`;
    const kevNew = newFindings.some((f) => f.kev === true);
    const subject = kevNew ? `Known-exploited vulnerability in plugin ${ref}` : `Rescan found new Critical/High in plugin ${ref}`;
    const fixable = newFindings.filter((f) => f.fixedIn.length > 0);
    const text = `The nightly vulnerability rescan found ${newFindings.length} new critical/high finding${newFindings.length === 1 ? '' : 's'} in ${ref} `
      + `(now ${n.critical} critical, ${n.high} high).`
      + (kevNew ? ` ${newFindings.filter((f) => f.kev === true).length} of them ${newFindings.filter((f) => f.kev === true).length === 1 ? 'is' : 'are'} on the CISA Known Exploited Vulnerabilities list.` : '')
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
      const affected = await affectedPipelines(n, target.orgId);
      // The pipeline writers of an org whose pipelines run the version hear it in
      // the same notice (the relay de-duplicates anyone on both lists), worded for
      // them: which pipeline, which step, and the version to move to.
      const toOwners = prefs.notifyPipelineOwners && affected.length > 0;
      const orgText = `${text}${toOwners ? pipelineOwnerText(n, affected) : affectedPipelinesText(affected)}`;
      const recipients = [...await recipientsFor(prefs, target.uploaderId), ...(toOwners ? await pipelineOwnerRecipients(prefs) : [])];
      await sendRelay('N31', recipients, { subject, text: orgText }, opts);
      await sendWebhook(prefs, {
        event: 'N31',
        type: 'plugin.rescan.findings',
        orgId: target.orgId,
        plugin: n.plugin,
        version: n.version,
        ...(n.imageDigest ? { imageDigest: n.imageDigest } : {}),
        subject,
        text: orgText,
        critical: n.critical,
        high: n.high,
        findings: newFindings,
        affectedPipelines: affected.map((p) => ({ id: p.pipelineId, name: p.pipelineName, source: p.source, imageDigest: p.imageDigest, steps: p.steps })),
        ...(kevNew ? { kevNew: true } : {}),
        ...(n.suggestedVersion ? { suggestedVersion: n.suggestedVersion } : {}),
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

/** At most this many affected pipelines are named in one notice's text. */
const N31_MAX_NAMED_PIPELINES = 20;

/**
 * The org's pipelines declaring or running the rescanned version — on its image
 * when the notice names one. Read elevated (the notice is sent from the rescan,
 * across orgs), narrowed to `orgId`. A failed read names none rather than losing
 * the notice: "a version you use has new findings" still needs to arrive.
 */
async function affectedPipelines(n: RescanFindingsNotice, orgId: string): Promise<PipelineOnVersion[]> {
  // A listed version is reported as `<publisher>/<name>`; an org row by name.
  const slash = n.plugin.indexOf('/');
  const publisher = slash === -1 ? null : n.plugin.slice(0, slash);
  const name = slash === -1 ? n.plugin : n.plugin.slice(slash + 1);
  try {
    return await runWithTenantContext({ isSuperAdmin: true }, () => pipelinesOnVersion({
      pluginName: name,
      pluginVersion: n.version,
      pluginPublisher: publisher,
      ...(n.imageDigest ? { imageDigest: n.imageDigest } : {}),
      orgIds: [orgId],
    }));
  } catch (err) {
    logger.warn('Affected pipelines unreadable; N31 sent without them', { versionKey: n.versionKey, orgId, error: errorMessage(err) });
    return [];
  }
}

/** The "affected pipelines" paragraph of an N31 notice (empty when none). */
function affectedPipelinesText(pipelines: readonly PipelineOnVersion[]): string {
  if (pipelines.length === 0) return '';
  const byId = new Map<string, { name: string; sources: Set<string> }>();
  for (const p of pipelines) {
    const entry = byId.get(p.pipelineId) ?? { name: p.pipelineName ?? p.pipelineId, sources: new Set<string>() };
    entry.sources.add(p.source);
    byId.set(p.pipelineId, entry);
  }
  const lines = [...byId.values()].slice(0, N31_MAX_NAMED_PIPELINES)
    .map((e) => `  • ${e.name} (${[...e.sources].sort().join(' + ')})`);
  const more = byId.size > N31_MAX_NAMED_PIPELINES ? `\n  … and ${byId.size - N31_MAX_NAMED_PIPELINES} more` : '';
  return `\n\nAffected pipelines (${byId.size}) — "deployed" runs it now, "declared" resolves to it at the next synth:\n${lines.join('\n')}${more}`;
}

/** The pipeline-owner paragraph of an N31 notice: each affected pipeline's steps, and the way out. */
function pipelineOwnerText(n: RescanFindingsNotice, pipelines: readonly PipelineOnVersion[]): string {
  const ref = `${n.plugin}@${n.version}`;
  const byId = new Map<string, { name: string; lines: string[] }>();
  for (const p of pipelines) {
    const entry = byId.get(p.pipelineId) ?? { name: p.pipelineName ?? p.pipelineId, lines: [] };
    const where = p.source === 'deployed' ? 'runs' : 'resolves to (at its next synth)';
    for (const step of p.steps.length > 0 ? p.steps : ['(a step)']) entry.lines.push(`step ${step} ${where} ${ref}`);
    byId.set(p.pipelineId, entry);
  }
  const lines = [...byId.values()].slice(0, N31_MAX_NAMED_PIPELINES)
    .map((e) => `  • pipeline ${e.name}: ${[...new Set(e.lines)].join('; ')}`);
  const more = byId.size > N31_MAX_NAMED_PIPELINES ? `\n  … and ${byId.size - N31_MAX_NAMED_PIPELINES} more` : '';
  const way = n.suggestedVersion
    ? `Upgrade to ${n.plugin}@${n.suggestedVersion}, then re-synth (deployed steps keep the old image until the next deploy).`
    : 'Upgrade to a fixed version once one is published, then re-synth; or record a time-boxed risk acceptance on the pipeline\'s security page.';
  return `\n\nYour pipelines on ${ref} (${byId.size}):\n${lines.join('\n')}${more}\n\n${way}`;
}

/** A pipeline whose lookup or runtime check graded its plugin version `error` or louder (N32). */
export interface PipelineVulnerableNotice {
  orgId: string;
  pipelineId: string;
  pipelineName: string | null;
  stepKey: string;
  /** `<publisher>/<name>` for a listing, the name for an org plugin. */
  plugin: string;
  version: string;
  severity: VulnSeverity;
  /** The warnings at `error` or louder. */
  warnings: Array<{ code: string; severity: VulnSeverity; message: string }>;
  suggestedVersion?: string | null;
  /** `removal`: someone tried to delete the version, and this pipeline is what holds it. */
  trigger: 'lookup' | 'runtime-check' | 'removal';
}

/**
 * N32: a pipeline is about to run (or runs) a plugin version graded `error` or
 * louder. Deduplicated per (pipeline, version) for 24 hours — synth retries and
 * every step of a fan-out would otherwise send one each. Honors
 * `notifyPipelineOwners`; the store fails OPEN. Never throws.
 */
export async function notifyPipelineVulnerable(n: PipelineVulnerableNotice): Promise<void> {
  try {
    const prefs = await prefsStore.get(n.orgId);
    if (!prefs.notifyPipelineOwners) return;
    let fresh: string[];
    try {
      fresh = await dedupe.claimNew(`plugin-security:n32:${n.pipelineId}:${n.plugin}@${n.version}`, [n.severity], N32_DEDUPE_TTL_MS);
    } catch (err) {
      logger.warn('N32 dedupe store unavailable; notifying anyway', { pipelineId: n.pipelineId, error: errorMessage(err) });
      fresh = [n.severity];
    }
    if (fresh.length === 0) {
      incCounter('plugin_security_notifications_deduplicated_total', { event: 'N32' });
      return;
    }
    const pipeline = n.pipelineName ?? n.pipelineId;
    const ref = `${n.plugin}@${n.version}`;
    const subject = `Pipeline ${pipeline} runs a vulnerable plugin (${n.severity}): ${ref}`;
    const what = n.trigger === 'lookup' ? 'Synth' : n.trigger === 'runtime-check' ? 'A runtime check' : 'A removal attempt';
    const text = `${what} of pipeline ${pipeline}: step ${n.stepKey} runs ${ref}, graded ${n.severity.toUpperCase()}. `
      + (n.trigger === 'removal' ? 'The version cannot be deleted while this pipeline uses it. ' : '')
      + 'The pipeline is not stopped — vulnerability findings never block a pipeline — so this is the signal to act on.\n\n'
      + n.warnings.map((w) => `  • [${w.severity}] ${w.message}`).join('\n')
      + (n.suggestedVersion ? `\n\nUpgrade the step to ${n.plugin}@${n.suggestedVersion}.` : '\n\nUpgrade the step to a fixed version once one is published, or record a time-boxed risk acceptance on the pipeline\'s security page.');
    await sendRelay('N32', await pipelineOwnerRecipients(prefs), { subject, text }, { immediate: true });
    await sendWebhook(prefs, {
      event: 'N32',
      type: 'pipeline.plugin.vulnerable',
      orgId: n.orgId,
      plugin: n.plugin,
      version: n.version,
      subject,
      text,
      pipeline: { id: n.pipelineId, name: n.pipelineName },
      stepKey: n.stepKey,
      severity: n.severity,
      warnings: n.warnings,
      trigger: n.trigger,
      ...(n.suggestedVersion ? { suggestedVersion: n.suggestedVersion } : {}),
      occurredAt: new Date().toISOString(),
    });
    incCounter('plugin_security_notifications_total', { event: 'N32' });
  } catch (err) {
    incCounter('plugin_security_notification_failed_total', { event: 'N32' });
    logger.warn('Pipeline-vulnerable notice failed', { orgId: n.orgId, pipelineId: n.pipelineId, error: errorMessage(err) });
  }
}

/** One lapsed acceptance, as N33 reports it. */
export interface LapsedAcceptanceNotice {
  exposureId: string;
  orgId: string;
  pipelineId: string;
  pipelineName?: string | null;
  plugin: string;
  version: string;
  imageDigest: string | null;
  acceptedUntil: Date | null;
  triagedBy: string | null;
  reason: string | null;
}

/**
 * N33: pipelines' risk acceptances lapsed — one notice per org listing them
 * (the person who accepted rides along while still a member). Honors
 * `notifyPipelineOwners`. Returns the orgs notified; never throws.
 */
export async function notifyAcceptancesLapsed(lapsed: readonly LapsedAcceptanceNotice[]): Promise<number> {
  const byOrg = new Map<string, LapsedAcceptanceNotice[]>();
  for (const l of lapsed) byOrg.set(l.orgId, [...(byOrg.get(l.orgId) ?? []), l]);
  let notified = 0;
  for (const [orgId, rows] of byOrg) {
    try {
      const prefs = await prefsStore.get(orgId);
      if (!prefs.notifyPipelineOwners) continue;
      const subject = `${rows.length} pipeline risk acceptance${rows.length === 1 ? '' : 's'} lapsed`;
      const lines = rows.slice(0, N31_MAX_NAMED_PIPELINES).map((r) =>
        `  • pipeline ${r.pipelineName ?? r.pipelineId}: ${r.plugin}@${r.version} (accepted until ${r.acceptedUntil?.toISOString() ?? 'unknown'}${r.reason ? ` — "${r.reason}"` : ''})`);
      const more = rows.length > N31_MAX_NAMED_PIPELINES ? `\n  … and ${rows.length - N31_MAX_NAMED_PIPELINES} more` : '';
      const text = `These risk acceptances passed their deadline. Their findings are live again: the pipelines' lookups and runtime checks grade them again, their owners are notified again, and the exposures are open in reports.\n\n${lines.join('\n')}${more}`
        + '\n\nUpgrade the steps to a fixed version, or record a new acceptance with a reason and an expiry.';
      const accepters = [...new Set(rows.map((r) => r.triagedBy).filter((u): u is string => !!u && u !== SYSTEM_ACTOR_ID && /^[0-9a-f]{24}$/i.test(u)))];
      const recipients: EcosystemRecipientSpec[] = [
        ...await pipelineOwnerRecipients(prefs),
        ...(accepters.length > 0 ? [{ kind: 'org_members' as const, orgId, userIds: accepters.slice(0, MAX_TARGET_USERS) }] : []),
      ];
      await sendRelay('N33', recipients, { subject, text }, { immediate: true });
      await sendWebhook(prefs, {
        event: 'N33',
        type: 'pipeline.vuln.acceptance_lapsed',
        orgId,
        plugin: null,
        version: null,
        subject,
        text,
        acceptances: rows.map((r) => ({
          exposureId: r.exposureId,
          pipelineId: r.pipelineId,
          plugin: r.plugin,
          version: r.version,
          imageDigest: r.imageDigest,
          acceptedUntil: r.acceptedUntil?.toISOString() ?? null,
          triagedBy: r.triagedBy,
          reason: r.reason,
        })),
        occurredAt: new Date().toISOString(),
      });
      notified++;
    } catch (err) {
      incCounter('plugin_security_notification_failed_total', { event: 'N33' });
      logger.warn('Lapsed-acceptance notice failed', { orgId, error: errorMessage(err) });
    }
  }
  incCounter('plugin_security_notifications_total', { event: 'N33' }, notified);
  return notified;
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
