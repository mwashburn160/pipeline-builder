// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proactive quota warnings: an 80% and a 100% notice per (account, quota type,
 * period), sent the moment an increment crosses the line instead of when the
 * first request bounces.
 *
 * Delivered to the account ROOT — the pool's usage is the account's — three ways:
 *   - the message service's internal notify route (the org inbox, with the
 *     real-time ping);
 *   - EMAIL to the root's admins/owners and billing contacts (members whose
 *     Roles grant `billing:manage`), through platform's relay
 *     (`POST /internal/notify-email`, the `quotaNotice` leg — platform owns SMTP
 *     and the user directory, so it resolves the recipients). An instance with
 *     no mail configured reports the send as done and nobody is mailed;
 *   - a `quota.threshold` webhook event when the account has configured one.
 * An account opts out of all three with its notice settings
 * (`PUT /quotas/:orgId/notice-settings`).
 *
 * Exactly once per period: the {@link QuotaNotice} insert IS the dedupe (unique
 * index), so concurrent increments on every replica crossing 80% together send
 * one notice. A notice is best effort — it never fails or slows the increment;
 * every outcome is counted on `quota_threshold_notices_total{type,threshold,outcome}`.
 *
 * Cheap on the hot path: a per-pod memo of the notices already claimed (or
 * found claimed) this period short-circuits before any read, so an org pinned
 * at its cap — every refusal reports "100%" — costs one settings read and one
 * duplicate-key insert per pod per period, not per refusal. The notice settings
 * are memoized for {@link SETTINGS_TTL_MS}.
 */

import {
  createLogger,
  createSafeClient,
  createWebhookChannel,
  emitCounter,
  errorMessage,
  getServiceAuthHeader,
  NOTIFY_EMAIL_PATH,
  QUOTA_TYPE_LABELS,
  QUOTA_UPGRADE_PATH,
  enforcedQuotaLimit,
  formatQuotaAmount,
  quotaAccrual,
  quotaObservation,
  sendSystemNotification,
  serviceEndpoint,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { config } from '../config.js';
import { QUOTA_NOTICE_THRESHOLDS, QuotaNotice, QuotaNoticeSettings, type QuotaNoticeThreshold } from '../models/quota-notice.js';

/** How long a read of an account's notice settings is reused (an opt-out applies within it). */
const SETTINGS_TTL_MS = 60_000;

/** Bound on each per-pod memo below. */
const MEMO_MAX_ENTRIES = 10_000;

/** `root|type|period|threshold` of every notice this pod knows is claimed. */
const claimedNotices = new Set<string>();

/** Memoized notice settings per root. */
const settingsMemo = new Map<string, { value: { enabled?: boolean; webhookUrl?: string | null } | null; expires: number }>();

function noticeKey(input: ThresholdInput, threshold: QuotaNoticeThreshold): string {
  return `${input.rootOrgId}|${input.quotaType}|${input.resetAt ?? 'unknown'}|${threshold}`;
}

function rememberClaimed(key: string): void {
  if (claimedNotices.size >= MEMO_MAX_ENTRIES) {
    const oldest = claimedNotices.values().next();
    if (!oldest.done) claimedNotices.delete(oldest.value);
  }
  claimedNotices.add(key);
}

async function noticeSettings(rootOrgId: string): Promise<{ enabled?: boolean; webhookUrl?: string | null } | null> {
  const hit = settingsMemo.get(rootOrgId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await QuotaNoticeSettings.findOne({ orgId: rootOrgId }).lean();
  if (settingsMemo.size >= MEMO_MAX_ENTRIES) {
    const oldest = settingsMemo.keys().next();
    if (!oldest.done) settingsMemo.delete(oldest.value);
  }
  settingsMemo.set(rootOrgId, { value: value ?? null, expires: Date.now() + SETTINGS_TTL_MS });
  return value ?? null;
}

/** Drop the per-pod memos (tests; a safe operational reset). */
export function clearThresholdMemos(): void {
  claimedNotices.clear();
  settingsMemo.clear();
}

const logger = createLogger('threshold-notifier');

/** The `quota.threshold` webhook event name. */
export const QUOTA_THRESHOLD_EVENT = 'quota.threshold';

const NOTICES_METRIC = 'quota_threshold_notices_total';

/** The binding counter after a write: the pool's for a pooled account, else the org's own. */
export interface ThresholdInput {
  rootOrgId: string;
  quotaType: QuotaType;
  limit: number;
  /** Usage AFTER the write (or at the refusal). */
  used: number;
  /** Units the write added; 0 for a refusal. */
  amount: number;
  /** ISO reset of the period the counter is in — identifies the period. */
  resetAt?: string;
  /**
   * Which path produced this input. `increment` (the default) is the metered
   * write path; `sweep` is the storage sweep.
   *
   * It exists to make ONE rule precise. `storageBytes` is "the one quota
   * nothing increments" — the registry measures a namespace live and gates its
   * own pushes — so a storage notice arriving from the increment path could
   * only be a bug, and this used to be expressed as a blanket
   * `quotaType === 'storageBytes'` exclusion that also made storage
   * unnotifiable at all. That is why no proactive storage notice was ever sent
   * on any tier. Now the exclusion is directional: storage notifies only from
   * the sweep, and every per-period quota only from an increment.
   */
  source?: 'increment' | 'sweep';
}

/**
 * The thresholds a write moved the counter across: `before < t% ≤ after`. A
 * refusal (amount 0, used at or past the limit) reports 100 so the account
 * still hears about a limit it hit before any notice could fire (e.g. the cap
 * was lowered under it). Unlimited (-1) and zero limits never notify — a 0 cap
 * is a deliberate "none", not a surprise.
 */
export function crossedThresholds(limit: number, used: number, amount: number): QuotaNoticeThreshold[] {
  if (limit <= 0) return [];
  const before = used - amount;
  return QUOTA_NOTICE_THRESHOLDS.filter((t) => used * 100 >= t * limit && (amount === 0 || before * 100 < t * limit));
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** The inbox notice's subject + body. */
export function thresholdNoticeText(input: ThresholdInput, threshold: QuotaNoticeThreshold): { subject: string; content: string } {
  const label = QUOTA_TYPE_LABELS[input.quotaType];
  const when = input.resetAt ? input.resetAt.slice(0, 10) : 'the end of the period';
  const band = enforcedQuotaLimit(input.quotaType, input.limit);
  // The soft band makes a 100% notice a WARNING rather than a stop, so the copy
  // has to say so. Driven by `enforcedQuotaLimit` rather than by naming a quota
  // type: this was `=== 'automationCalls'`, so storage — which gained a band for
  // the same reason — would have been told it was refused while it was not.
  if (threshold >= 100 && band > input.limit) {
    return {
      subject: `${label} quota reached`,
      content: quotaAccrual(input.quotaType) === 'stock'
        // A band on a STOCK is a one-time buffer, not a periodic one, and the
        // copy must not imply a reset it will never get.
        ? `Your organization has used all ${formatQuotaAmount(input.quotaType, input.limit)} of its ${label.toLowerCase()}. Pushes keep working up to ${formatQuotaAmount(input.quotaType, band)} — a one-time buffer, not a periodic one — then are refused until space is freed or capacity is added. Retire plugin versions at /dashboard/plugins, or add a Storage Pack at ${QUOTA_UPGRADE_PATH}.`
        : `Your organization has used all ${input.limit.toLocaleString('en-US')} of its ${label.toLowerCase()} quota for this period. Pipelines and other automation keep running for a grace band of up to ${band.toLocaleString('en-US')} calls, then are refused until the quota resets on ${when}. Add an Automation Pack or upgrade at ${QUOTA_UPGRADE_PATH}, or see what used it at /dashboard/quotas.`,
    };
  }
  // A STOCK never resets, so none of the period copy below is true for it: no
  // "this period", no "resets on", and the remedy is freeing bytes rather than
  // waiting. Storage is the only stock quota that notifies.
  if (quotaAccrual(input.quotaType) === 'stock') {
    const used = formatQuotaAmount(input.quotaType, input.used);
    const cap = formatQuotaAmount(input.quotaType, input.limit);
    return threshold >= 100
      ? {
        subject: `${label} full`,
        content: `Your organization has used all ${cap} of its ${label.toLowerCase()}. New image pushes are refused until space is freed or capacity is added — existing images stay available and running pipelines are unaffected. Free space by retiring plugin versions you no longer need at /dashboard/plugins, or add a Storage Pack at ${QUOTA_UPGRADE_PATH}.`,
      }
      : {
        subject: `${label} at ${threshold}%`,
        content: `Your organization has used ${used} of ${cap} ${label.toLowerCase()} (${threshold}%). Storage does not reset — it stays used until you free it. Usage counts each distinct image layer ONCE, so publishing another version of an existing plugin costs little and changing a base image costs most. Retire versions you no longer need at /dashboard/plugins, or add a Storage Pack at ${QUOTA_UPGRADE_PATH}.`,
      };
  }
  if (threshold >= 100) {
    return {
      subject: `${label} quota reached`,
      content: `Your organization has used all ${input.limit.toLocaleString('en-US')} of its ${label.toLowerCase()} quota for this period. New requests that need it are refused until it resets on ${when}. Raise the limit at ${QUOTA_UPGRADE_PATH}, or see what used it at /dashboard/quotas.`,
    };
  }
  return {
    subject: `${label} quota at ${threshold}%`,
    content: `Your organization has used ${input.used.toLocaleString('en-US')} of ${input.limit.toLocaleString('en-US')} ${label.toLowerCase()}s this period (${threshold}%). It resets on ${when}. See what is using it at /dashboard/quotas, or raise the limit at ${QUOTA_UPGRADE_PATH}.`,
  };
}

/**
 * Send whichever notices `input` crossed. Fire-and-forget at the call site:
 * resolves after every send attempt, never rejects.
 */
export async function notifyThresholds(input: ThresholdInput): Promise<void> {
  if (!config.quota.thresholdNoticesEnabled) return;
  // A MEASURED quota can only be known by the sweep; a METERED one can only be
  // known by an increment. Either arriving from the other path is a bug, not a
  // notice — see `ThresholdInput.source`.
  //
  // Keyed on `observed`, not on `accrual`: the create-time count quotas
  // (`dashboards`, `listings`, …) are stocks that ARE incremented, so an
  // accrual test would have silenced every one of them.
  const fromSweep = input.source === 'sweep';
  if (fromSweep !== (quotaObservation(input.quotaType) === 'measured')) return;
  // Already-claimed notices are dropped before any read. A refusal (nothing
  // counted) can only ever report 100%, so once that is claimed this period an
  // org pinned at its cap costs nothing here.
  const thresholds = crossedThresholds(input.limit, input.used, input.amount)
    .filter((t) => !claimedNotices.has(noticeKey(input, t)));
  if (thresholds.length === 0) return;
  try {
    const settings = await noticeSettings(input.rootOrgId);
    if (settings && settings.enabled === false) {
      for (const t of thresholds) emitCounter(NOTICES_METRIC, { type: input.quotaType, threshold: String(t), outcome: 'opted_out' });
      return;
    }
    // Highest first: a write that jumps straight past 100% sends the "reached"
    // notice; the 80% one is still claimed so it can't arrive after it.
    for (const threshold of [...thresholds].sort((a, b) => b - a)) {
      try {
        await QuotaNotice.create({
          rootOrgId: input.rootOrgId,
          quotaType: input.quotaType,
          periodResetAt: input.resetAt ?? 'unknown',
          threshold,
        });
      } catch (err) {
        if (isDuplicateKey(err)) {
          rememberClaimed(noticeKey(input, threshold)); // another write already sent it
          continue;
        }
        throw err;
      }
      rememberClaimed(noticeKey(input, threshold));
      if (threshold < 100 && thresholds.includes(100)) {
        emitCounter(NOTICES_METRIC, { type: input.quotaType, threshold: String(threshold), outcome: 'superseded' });
        continue;
      }
      const text = thresholdNoticeText(input, threshold);
      const delivered = await sendSystemNotification({
        recipientOrgId: input.rootOrgId,
        subject: text.subject,
        content: text.content,
        priority: threshold >= 100 ? 'high' : 'normal',
      });
      emitCounter(NOTICES_METRIC, { type: input.quotaType, threshold: String(threshold), outcome: delivered ? 'sent' : 'failed' });
      await deliverEmail(input, threshold, text);
      if (settings?.webhookUrl) await deliverWebhook(settings.webhookUrl, input, threshold, text.subject);
    }
  } catch (err) {
    emitCounter(NOTICES_METRIC, { type: input.quotaType, threshold: 'any', outcome: 'failed' });
    logger.warn('Quota threshold notice failed', { rootOrgId: input.rootOrgId, quotaType: input.quotaType, error: errorMessage(err) });
  }
}

let platformClient: ReturnType<typeof createSafeClient> | null = null;
function platform(): ReturnType<typeof createSafeClient> {
  platformClient ??= createSafeClient({ ...serviceEndpoint('platform'), timeout: 5000 });
  return platformClient;
}

/**
 * Email the notice to the root's admins/owners + billing contacts through
 * platform's relay. The token is scoped to the ROOT org: the relay is
 * tenant-bound, so it can only mail the account the notice is about. Best
 * effort like every other leg — counted on `quota_threshold_emails_total`, never
 * thrown (the inbox notice above has already landed).
 */
async function deliverEmail(
  input: ThresholdInput,
  threshold: QuotaNoticeThreshold,
  text: { subject: string; content: string },
): Promise<void> {
  let outcome: 'sent' | 'failed' = 'failed';
  try {
    // api-core's shared path. The endpoint serves five callers; its `quotaNotice`
    // leg accepts only the `quota` caller, which is this one.
    const response = await platform().post(NOTIFY_EMAIL_PATH, {
      quotaNotice: true,
      orgId: input.rootOrgId,
      subject: text.subject,
      text: text.content,
    }, {
      headers: { authorization: getServiceAuthHeader({ serviceName: 'quota', orgId: input.rootOrgId, role: 'member' }) },
      maxRetries: 0,
    });
    // The client resolves on a 4xx/5xx, so the status is the only refusal signal.
    if (response && response.statusCode < 400) outcome = 'sent';
    else logger.warn('Quota threshold email refused by the relay', { rootOrgId: input.rootOrgId, status: response?.statusCode });
  } catch (err) {
    logger.warn('Quota threshold email failed', { rootOrgId: input.rootOrgId, error: errorMessage(err) });
  }
  emitCounter('quota_threshold_emails_total', { type: input.quotaType, threshold: String(threshold), outcome });
}

const webhook = createWebhookChannel({ name: 'quota-webhook' });

/** The `quota.threshold` event body. Numbers only — nothing the org's own dashboard doesn't show. */
export function thresholdWebhookPayload(input: ThresholdInput, threshold: QuotaNoticeThreshold): Record<string, unknown> {
  return {
    event: QUOTA_THRESHOLD_EVENT,
    orgId: input.rootOrgId,
    quotaType: input.quotaType,
    threshold,
    limit: input.limit,
    used: input.used,
    resetAt: input.resetAt ?? null,
    upgradeUrl: QUOTA_UPGRADE_PATH,
    occurredAt: new Date().toISOString(),
  };
}

async function deliverWebhook(url: string, input: ThresholdInput, threshold: QuotaNoticeThreshold, subject: string): Promise<void> {
  const payload = thresholdWebhookPayload(input, threshold);
  const result = await webhook.deliver({
    recipientOrgId: input.rootOrgId,
    subject,
    body: subject,
    priority: threshold >= 100 ? 'high' : 'normal',
    messageType: 'announcement',
    payload,
  }, { value: url, orgId: input.rootOrgId });
  emitCounter('quota_threshold_webhooks_total', { type: input.quotaType, outcome: result.ok ? 'delivered' : 'failed' });
  if (!result.ok) logger.warn('quota.threshold webhook not delivered', { rootOrgId: input.rootOrgId, code: result.code, error: result.error });
}
