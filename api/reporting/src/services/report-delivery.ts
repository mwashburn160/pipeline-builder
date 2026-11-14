// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Getting a finished report to the people it was written for.
 *
 * FOUR CHANNELS, and only one of them is new plumbing:
 *
 *  - IN-APP, through the message service's system-notification route. Always sent,
 *    and the only channel guaranteed to work on an install with no mail.
 *  - EMAIL, through platform's relay (it holds the SMTP credentials). One message per
 *    address, each with its own unsubscribe link — see platform's `notifyReport` for
 *    why a shared `to:` header would be both a disclosure and an unsubscribe bug.
 *  - SLACK and TEAMS, through the ADMIN-OWNED alert destinations that already exist.
 *    Nothing here creates a destination, and nothing here can name a URL: the org's
 *    admins decided where this org's notifications go, and a report is a notification.
 *    A Teams incoming webhook is an HTTPS endpoint, so it is the existing `webhook`
 *    destination rather than a new channel type — adding a `teams` channel would be a
 *    second admin surface for a thing the first one already does.
 *
 * NO EMAIL CONFIGURED ⇒ IN-APP ONLY. Local and minikube installs usually have no SES
 * or SMTP, and `utils/email.ts` reports a disabled send as SUCCESS. Without asking
 * platform's status endpoint first, every one of those installs would record a report
 * as delivered to managers who never received it. The schedule form warns the lead
 * about this before they choose email at all.
 *
 * A BOUNCE IS A FACT, NOT A GUESS. The relay reports which addresses the transport
 * refused, and each one increments that recipient's bounce count; at
 * `MAX_BOUNCES` the address stops being tried. Three rather than one, because a
 * single bounce is usually a full mailbox or an autoresponder, and dropping a manager
 * off the list for one of those is a silent failure nobody notices for a quarter.
 */

import {
  createLogger,
  createWebhookChannel,
  emitCounter,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  sendSystemNotification,
  serviceEndpoint,
  type NotificationMessage,
} from '@pipeline-builder/api-core';
import {
  listEnabledAlertDestinations,
  MAX_BOUNCES,
  stakeholderReportStore,
  type ReportDefinition,
  type ReportPauseReason,
  type ReportRecipient,
  type ReportRun,
} from '@pipeline-builder/pipeline-data';
import { publicBaseUrl as baseUrl, REPORTING_HTTP_TIMEOUT_MS } from '../helpers/report-helpers.js';

const logger = createLogger('report-delivery');

/** How long the instance-wide email switch is cached. */
const EMAIL_STATUS_TTL_MS = 60_000;

/** Per-destination delivery budget. A slow Slack must not hold up the next run. */
const DESTINATION_TIMEOUT_MS = 5_000;

/**
 * What delivering a run produced — stored on the run (`report_runs.delivery`) and
 * returned by the run view, so "did the board actually get last month's?" has an
 * answer on the report's own page.
 */
export interface DeliveryOutcome {
  /** `delivering` while a fan-out is in flight; `delivered` / `failed` once it ends. */
  state: 'delivering' | 'delivered' | 'failed';
  /** How many delivery attempts this run has had (1 on publish, +1 per redeliver). */
  attempts: number;
  /** When the latest attempt started (ISO). */
  attemptedAt: string;
  /** In-app notifications persisted (0 or 1 — one org notice per run). */
  inApp: number;
  /** `sent` counts every address that has the email, across attempts; `failed`
   *  and `skipped` describe the LATEST attempt. */
  email: { sent: number; failed: number; skipped: number };
  destinations: { delivered: number; failed: number };
  /** False ⇒ email was not attempted at all, and the report went in-app only. */
  emailAvailable: boolean;
  /** The email relay refused the call or could not be reached: NO address was
   *  tried, so those recipients are counted in `email.failed` (not as bounces). */
  relayFailed: boolean;
  /** Who already has it — what a redelivery skips so nobody gets it twice. */
  delivered: { recipientIds: string[]; destinationIds: string[] };
  /** Anything the lead should know about this delivery, in plain words. */
  notes: string[];
}

/** Whether a recorded delivery left anyone (or any channel) without the report. */
export function deliveryIncomplete(outcome: Pick<DeliveryOutcome, 'state' | 'inApp' | 'relayFailed' | 'email' | 'destinations'>): boolean {
  return outcome.state === 'failed'
    || outcome.inApp === 0
    || outcome.relayFailed
    || outcome.email.failed > 0
    || outcome.destinations.failed > 0;
}

function platform(): InternalHttpClient {
  const { host, port } = serviceEndpoint('platform');
  return new InternalHttpClient({ host, port });
}

let emailStatus: { enabled: boolean; at: number } | null = null;

/**
 * Whether this instance can send mail at all.
 *
 * Cached for a minute (the switch is instance-wide and changes at deploy time, so a
 * per-run call would be pure overhead), and FAIL-CLOSED: an unreachable platform reads
 * as "no email", which degrades the run to in-app and says so, rather than recording a
 * send nobody can confirm happened.
 */
export async function emailAvailable(now = Date.now()): Promise<boolean> {
  if (emailStatus && now - emailStatus.at < EMAIL_STATUS_TTL_MS) return emailStatus.enabled;
  let enabled = false;
  try {
    const res = await platform().get<{ data?: { enabled?: unknown } }>('/internal/notify-email/status', {
      headers: { Authorization: getServiceAuthHeader({ serviceName: 'reporting', role: 'member' }) },
      timeout: REPORTING_HTTP_TIMEOUT_MS,
    });
    enabled = res.statusCode < 400 && res.body?.data?.enabled === true;
  } catch (err) {
    logger.warn('Email status unreadable; treating this instance as mail-less', { error: errorMessage(err) });
  }
  emailStatus = { enabled, at: now };
  return enabled;
}

/** Clear the cached switch (tests, and a config reload). */
export function resetEmailStatus(): void {
  emailStatus = null;
}

/** The link a manager follows to read the report in the product. */
function runUrl(run: ReportRun): string {
  return `${baseUrl()}/reports?tab=stakeholder&run=${encodeURIComponent(run.id)}`;
}

/** The one-click unsubscribe endpoint for a recipient. */
function unsubscribeUrl(recipient: ReportRecipient): string | undefined {
  return recipient.unsubscribeToken
    ? `${baseUrl()}/api/public/report-recipients/unsubscribe?token=${encodeURIComponent(recipient.unsubscribeToken)}`
    : undefined;
}

/**
 * The email body.
 *
 * Deliberately short, and deliberately NOT the report. The snapshot is the authority
 * and it lives in the product behind the org's own access control; an email that
 * reproduced its numbers would be a second copy that can disagree with the first, and
 * it would put org data in a mailbox the org does not control. So the mail carries the
 * headline, the period, and a link.
 */
function emailBody(definition: ReportDefinition, run: ReportRun, headline: string | null): string {
  const lines = [
    `${definition.name} — ${run.periodLabel}`,
    '',
    ...(headline ? [headline, ''] : []),
    `Read it here: ${runUrl(run)}`,
  ];
  if (run.leadNotes) lines.push('', run.leadNotes);
  return lines.join('\n');
}

/** The one number worth putting in a subject line, if the snapshot has one. */
function headlineOf(run: ReportRun): string | null {
  const sections = (run.snapshot as { sections?: Array<Record<string, unknown>> } | null)?.sections;
  const withHeadline = sections?.find((s) => s.headline);
  const h = withHeadline?.headline as { label?: string; value?: number; unit?: string } | undefined;
  if (!h || typeof h.value !== 'number') return null;
  return `${h.label ?? 'Headline'}: ${h.value}${h.unit ?? ''}`;
}

/**
 * Deliver a PUBLISHED run to its recipients.
 *
 * The run must already be published — this function does not check, because the caller
 * that publishes is the only caller, and a delivery that re-derived the publish rule
 * would be a second place for it to be wrong.
 *
 * `previous` is the run's recorded outcome when this is a REDELIVERY: every channel and
 * recipient it already reached is skipped, so a retry after a relay outage reaches the
 * people who missed it and nobody twice.
 */
export async function deliverPublishedRun(
  definition: ReportDefinition,
  run: ReportRun,
  previous: DeliveryOutcome | null = null,
): Promise<DeliveryOutcome> {
  const already = {
    recipientIds: new Set(previous?.delivered.recipientIds ?? []),
    destinationIds: new Set(previous?.delivered.destinationIds ?? []),
  };
  const outcome: DeliveryOutcome = {
    state: 'delivered',
    attempts: (previous?.attempts ?? 0) + 1,
    attemptedAt: new Date().toISOString(),
    inApp: previous?.inApp ?? 0,
    email: { sent: already.recipientIds.size, failed: 0, skipped: 0 },
    destinations: { delivered: already.destinationIds.size, failed: 0 },
    emailAvailable: false,
    relayFailed: false,
    delivered: { recipientIds: [...already.recipientIds], destinationIds: [...already.destinationIds] },
    notes: [],
  };
  const headline = headlineOf(run);
  const subject = `${definition.name} — ${run.periodLabel}`;

  // 1. In-app, first and unconditionally. It is the channel that cannot be
  // misconfigured, so a report is never delivered nowhere. Once per run.
  if (outcome.inApp === 0) {
    if (await sendSystemNotification({
      recipientOrgId: definition.orgId,
      subject,
      content: emailBody(definition, run, headline),
      priority: 'normal',
    })) {
      outcome.inApp = 1;
    } else {
      outcome.notes.push('The in-app notification could not be posted.');
    }
  }

  // 2. Email, to verified recipients only — and on a redelivery, only those who
  // do not have it yet.
  outcome.emailAvailable = await emailAvailable();
  const recipients = (await stakeholderReportStore.getRecipients(definition.orgId, definition.recipients))
    .filter((r) => !already.recipientIds.has(r.id));
  const deliverable: ReportRecipient[] = [];
  for (const r of recipients) {
    const check = stakeholderReportStore.deliverability(r);
    if (check.deliverable) deliverable.push(r);
    else outcome.email.skipped += 1;
  }
  if (!outcome.emailAvailable) {
    if (deliverable.length > 0) {
      outcome.notes.push(
        `This instance has no outbound email configured, so ${deliverable.length} recipient(s) were not emailed. `
        + 'The report is available in the product, and a share link can be sent by hand.',
      );
      emitCounter('report_delivery_email_unavailable_total', { orgId: definition.orgId });
    }
  } else if (deliverable.length > 0) {
    const result = await sendReportEmail(definition, run, deliverable, subject, headline);
    if (result.relayFailed) {
      // Nobody was emailed, and none of it is a bounce: the addresses are fine and
      // the relay is not. Said in words, and counted as failed, so the record can't
      // read "0 failed" for a send that never happened.
      outcome.relayFailed = true;
      outcome.email.failed += deliverable.length;
      outcome.notes.push(
        `The email relay ${result.relayFailed === 'refused' ? 'refused the send' : 'could not be reached'}, `
        + `so ${deliverable.length} recipient(s) were not emailed. Redeliver once mail is working.`,
      );
    } else {
      const sentEmails = new Set(result.sent);
      for (const r of deliverable) {
        if (sentEmails.has(r.email)) outcome.delivered.recipientIds.push(r.id);
      }
      outcome.email.sent = outcome.delivered.recipientIds.length;
      outcome.email.failed += result.failed.length;
      // Each refused address is a bounce against that recipient, not a failed run.
      for (const email of result.failed) {
        const count = await stakeholderReportStore.recordBounce(definition.orgId, email);
        if (count >= MAX_BOUNCES) {
          outcome.notes.push(`One recipient address has now bounced ${count} times and will be skipped.`);
        }
      }
    }
  }

  // 3. The org's own Slack / Teams / webhook destinations.
  const fanOut = await deliverToDestinations(definition, run, subject, headline, already.destinationIds);
  outcome.delivered.destinationIds.push(...fanOut.deliveredIds);
  outcome.destinations = { delivered: outcome.delivered.destinationIds.length, failed: fanOut.failed };
  if (fanOut.failed > 0) {
    outcome.notes.push(`${fanOut.failed} Slack / Teams / webhook destination(s) did not accept the report.`);
  }

  if (deliveryIncomplete(outcome)) outcome.state = 'failed';
  emitCounter('report_delivered_total', {
    orgId: definition.orgId,
    cadence: definition.cadence,
  });
  return outcome;
}

/** How long a `delivering` record blocks a redelivery: past this, the attempt is
 *  presumed dead (the pod running it went away) and a redelivery may proceed. */
export const DELIVERY_STALE_MS = 15 * 60 * 1000;

/** The run's recorded delivery, or null when it holds none (the column is untyped jsonb, so it is checked, not cast). */
export function recordedDelivery(run: ReportRun): DeliveryOutcome | null {
  const d = run.delivery as Partial<DeliveryOutcome> | null | undefined;
  return d && typeof d.state === 'string' && d.delivered ? d as DeliveryOutcome : null;
}

/**
 * Deliver a published run, RECORD the outcome on the run, and tell the lead when
 * it left anybody out — the single path the publish route, the scheduler's
 * auto-send and the redeliver route all take. NEVER THROWS: it runs detached
 * from (or after) the request that caused it.
 *
 * The record is written twice: `delivering` before the fan-out, the outcome after.
 * A pod that dies mid-fan-out therefore leaves a visible `delivering` record that
 * goes stale, instead of no record at all.
 */
export async function deliverAndRecord(
  definition: ReportDefinition,
  run: ReportRun,
  previous: DeliveryOutcome | null = null,
): Promise<DeliveryOutcome> {
  const startedAt = new Date().toISOString();
  try {
    await stakeholderReportStore.recordDelivery(definition.orgId, run.id, {
      ...(previous ?? {
        inApp: 0,
        email: { sent: 0, failed: 0, skipped: 0 },
        destinations: { delivered: 0, failed: 0 },
        emailAvailable: false,
        relayFailed: false,
        delivered: { recipientIds: [], destinationIds: [] },
        notes: [],
      }),
      state: 'delivering',
      attempts: (previous?.attempts ?? 0) + 1,
      attemptedAt: startedAt,
    } satisfies DeliveryOutcome as unknown as Record<string, unknown>);
    const outcome = await deliverPublishedRun(definition, run, previous);
    await stakeholderReportStore.recordDelivery(definition.orgId, run.id, outcome as unknown as Record<string, unknown>);
    if (outcome.state === 'failed') await notifyDeliveryFailed(definition, run, outcome);
    return outcome;
  } catch (err) {
    logger.warn('Report delivery failed', { orgId: definition.orgId, runId: run.id, error: errorMessage(err) });
    emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: 'publish' });
    const failed: DeliveryOutcome = {
      ...(previous ?? {
        inApp: 0,
        email: { sent: 0, failed: 0, skipped: 0 },
        destinations: { delivered: 0, failed: 0 },
        emailAvailable: false,
        relayFailed: false,
        delivered: { recipientIds: [], destinationIds: [] },
      }),
      state: 'failed',
      attempts: (previous?.attempts ?? 0) + 1,
      attemptedAt: startedAt,
      notes: [`Delivery stopped before it finished: ${errorMessage(err)}. Redeliver to reach whoever it missed.`],
    };
    // Best-effort: if the store is what failed, this fails too and the log + counter
    // are all that is left — but the lead is still told.
    await stakeholderReportStore.recordDelivery(definition.orgId, run.id, failed as unknown as Record<string, unknown>)
      .catch((e) => logger.warn('Could not record the failed delivery', { runId: run.id, error: errorMessage(e) }));
    await notifyDeliveryFailed(definition, run, failed);
    return failed;
  }
}

/**
 * Tell the lead a published report did not reach everyone, and how to fix it.
 * In-app to the OWNER plus email to them (when the instance has mail), like the
 * other lead notices. Never throws.
 */
export async function notifyDeliveryFailed(definition: ReportDefinition, run: ReportRun, outcome: DeliveryOutcome): Promise<void> {
  const subject = `${definition.name} — ${run.periodLabel} was not delivered to everyone`;
  const body = [
    `${definition.name} for ${run.periodLabel} is published, but its delivery was incomplete.`,
    '',
    ...(outcome.notes.length > 0 ? outcome.notes : ['One or more channels did not accept the report.']),
    '',
    'Open the report to see who has it, and redeliver to reach the rest — redelivery skips everyone who already received it.',
    runUrl(run),
  ].join('\n');
  try {
    await sendSystemNotification({
      recipientOrgId: definition.orgId,
      recipientUserId: definition.ownerId,
      subject,
      content: body,
      priority: 'high',
    });
    await emailOwner(definition, subject, body);
  } catch (err) {
    logger.warn('Could not notify the lead of a failed delivery', { runId: run.id, error: errorMessage(err) });
  }
  emitCounter('report_delivery_incomplete_total', { orgId: definition.orgId });
}

/** POST the report to platform's relay, one message per address. */
async function sendReportEmail(
  definition: ReportDefinition,
  run: ReportRun,
  recipients: readonly ReportRecipient[],
  subject: string,
  headline: string | null,
): Promise<{ sent: string[]; failed: string[]; relayFailed: false | 'refused' | 'unreachable' }> {
  try {
    const res = await platform().post<{ data?: { sent?: unknown; failed?: unknown } }>(
      '/internal/notify-email',
      {
        orgId: definition.orgId,
        subject,
        text: emailBody(definition, run, headline),
        reportRecipients: recipients.map((r) => ({
          email: r.email,
          ...(unsubscribeUrl(r) ? { unsubscribeUrl: unsubscribeUrl(r) } : {}),
        })),
      },
      {
        headers: {
          // Scoped to the org whose report this is: platform's relay is tenant-bound,
          // so a system-org token naming a tenant would be refused 403.
          Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId: definition.orgId, role: 'member' }),
        },
      },
    );
    const d = res.body?.data;
    if (res.statusCode >= 400 || !d) {
      // A refused CALL is not a bounce: the addresses are fine and the relay is not.
      // Counting it as one would retire a manager's address after three bad deploys.
      logger.warn('Report email relay refused the send', { orgId: definition.orgId, status: res.statusCode });
      emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: 'email' });
      return { sent: [], failed: [], relayFailed: 'refused' };
    }
    const strings = (v: unknown): string[] =>
      (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { sent: strings(d.sent), failed: strings(d.failed), relayFailed: false };
  } catch (err) {
    logger.warn('Report email relay unreachable', { orgId: definition.orgId, error: errorMessage(err) });
    emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: 'email' });
    return { sent: [], failed: [], relayFailed: 'unreachable' };
  }
}

/** The shared webhook transport: resolved-and-pinned host, redirects refused. */
const webhook = createWebhookChannel({ timeoutMs: DESTINATION_TIMEOUT_MS });

/**
 * Post to every enabled Slack / Teams / webhook destination the org's admins own.
 *
 * `in-app` and `email` destinations are skipped here rather than delivered twice: this
 * function's two siblings above already own those channels, and an org whose admins
 * configured an email alert destination would otherwise get the report twice, once
 * without an unsubscribe link.
 */
async function deliverToDestinations(
  definition: ReportDefinition,
  run: ReportRun,
  subject: string,
  headline: string | null,
  skip: ReadonlySet<string>,
): Promise<{ deliveredIds: string[]; failed: number }> {
  const deliveredIds: string[] = [];
  let failed = 0;
  const targets = (await listEnabledAlertDestinations(definition.orgId))
    .filter((d) => (d.channel === 'slack' || d.channel === 'webhook') && !skip.has(d.id));
  if (targets.length === 0) return { deliveredIds, failed };

  const msg: NotificationMessage = {
    recipientOrgId: definition.orgId,
    subject,
    body: emailBody(definition, run, headline),
    priority: 'normal',
    messageType: 'announcement',
    // Slack renders `text`; a Teams incoming webhook renders `text` too, which is why
    // one payload serves both and neither needs a card schema here.
    payload: {
      text: `*${subject}*\n${headline ?? ''}\n${runUrl(run)}`,
      report: { definitionId: definition.id, runId: run.id, period: run.periodLabel },
    },
  };

  for (const dest of targets) {
    try {
      // No secret: an alert destination's URL is itself the credential, so these
      // deliveries are unsigned — see `listEnabledAlertDestinations`.
      const res = await webhook.deliver(msg, { value: dest.target, orgId: definition.orgId });
      if (res.ok) {deliveredIds.push(dest.id);} else {
        failed += 1;
        emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: dest.channel });
      }
    } catch (err) {
      failed += 1;
      logger.warn('Report destination delivery failed', {
        orgId: definition.orgId, channel: dest.channel, error: errorMessage(err),
      });
      emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: dest.channel });
    }
  }
  return { deliveredIds, failed };
}

/**
 * Tell the lead a run is waiting for them.
 *
 * In-app to the OWNER only, plus email to that one person if the instance has mail.
 * Not to the org, and never to the recipients: the whole point of the review step is
 * that nothing reaches a manager before the lead has added the context the data cannot
 * supply.
 */
export async function notifyReadyForReview(definition: ReportDefinition, run: ReportRun): Promise<void> {
  const subject = `Review needed: ${definition.name} — ${run.periodLabel}`;
  const body = [
    `${definition.name} for ${run.periodLabel} is composed and waiting for your review.`,
    '',
    'Add the context the numbers cannot supply, then publish it.',
    '',
    runUrl(run),
  ].join('\n');
  await sendSystemNotification({
    recipientOrgId: definition.orgId,
    recipientUserId: definition.ownerId,
    subject,
    content: body,
    priority: 'normal',
  });
  await emailOwner(definition, subject, body);
  emitCounter('report_ready_for_review_total', { orgId: definition.orgId });
}

/**
 * Tell the lead a run FAILED, and why.
 *
 * A failed report has to be visible to the person who owns it, because the alternative
 * is a gap in the history that nobody explains — and a manager asking "where is this
 * week's report" is how the lead finds out.
 */
export async function notifyRunFailed(
  definition: ReportDefinition,
  period: string,
  reason: string,
): Promise<void> {
  const subject = `${definition.name} — ${period} could not be produced`;
  const body = [
    `${definition.name} for ${period} failed to compose.`,
    '',
    reason,
    '',
    'The schedule is unchanged and the next period will be attempted as usual.',
    `${baseUrl()}/reports?tab=stakeholder`,
  ].join('\n');
  await sendSystemNotification({
    recipientOrgId: definition.orgId,
    recipientUserId: definition.ownerId,
    subject,
    content: body,
    priority: 'high',
  });
  await emailOwner(definition, subject, body);
  emitCounter('report_run_failed_total', { orgId: definition.orgId, cadence: definition.cadence });
}

/**
 * Why a paused definition stopped, in the words the notice uses. Keyed by the
 * store's own pause-reason vocabulary, so a new reason cannot reach a lead as
 * `undefined`.
 */
const PAUSE_REASON_TEXT: Record<ReportPauseReason, string> = {
  entitlement: 'the Stakeholder Reports add-on is no longer active on this account',
  owner_inactive: 'the report\'s owner is no longer an active member of this organization',
  permission_lost: 'the report\'s owner no longer holds the permissions this report needs',
};

/**
 * Tell the lead their definition was PAUSED, and which of the three reasons it was.
 *
 * The reason matters more than the pause: an entitlement lapse is a billing
 * conversation, a deactivated owner is a handover, and a lost permission is an admin
 * question. A single "paused" notice would send all three to the wrong person.
 */
export async function notifyPaused(definition: ReportDefinition, reason: ReportPauseReason): Promise<void> {
  const why = PAUSE_REASON_TEXT[reason];
  const subject = `${definition.name} is paused`;
  const body = [
    `${definition.name} has stopped running because ${why}.`,
    '',
    'Published reports and existing share links are unaffected. Resolve the cause and',
    'resume the report to start it again.',
    '',
    `${baseUrl()}/reports?tab=stakeholder`,
  ].join('\n');
  // To the ORG inbox, not the owner alone: two of the three reasons are things the owner
  // cannot fix, and one of them is that the owner is gone.
  await sendSystemNotification({
    recipientOrgId: definition.orgId,
    subject,
    content: body,
    priority: 'high',
  });
  emitCounter('report_definition_paused_total', { orgId: definition.orgId, reason });
}

/**
 * Mail a recipient the link that confirms their address (`/reports/confirm`).
 *
 * The ONLY place the confirmation token leaves the service: it goes to the address
 * being confirmed and nowhere else, so confirming is something only the holder of
 * that mailbox can do. Through platform's per-address REPORT leg, which takes an
 * address reporting vouches for — the address is not a platform user, so the tenant
 * leg (which resolves members) cannot reach it.
 *
 * Returns whether the relay accepted it. NEVER THROWS, and an instance with no mail
 * returns false without trying: the address stays unverified and nothing is ever
 * delivered to it, which is the safe failure.
 */
export async function sendRecipientConfirmation(orgId: string, email: string, token: string): Promise<boolean> {
  if (!(await emailAvailable())) return false;
  try {
    const res = await platform().post<{ data?: { sent?: unknown } }>(
      '/internal/notify-email',
      {
        orgId,
        subject: 'Confirm your address for delivery reports',
        text: [
          'Someone in an organization on Pipeline Builder added this address to the list for its engineering delivery reports.',
          '',
          `Confirm it here: ${baseUrl()}/reports/confirm?token=${encodeURIComponent(token)}`,
          '',
          'Nothing is sent to this address until it is confirmed. If you were not expecting this, ignore it.',
        ].join('\n'),
        reportRecipients: [{ email }],
      },
      {
        headers: { Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId, role: 'member' }) },
        timeout: REPORTING_HTTP_TIMEOUT_MS,
      },
    );
    const sent = res.statusCode < 400 && Array.isArray(res.body?.data?.sent) && res.body.data.sent.length > 0;
    if (!sent) emitCounter('report_delivery_failed_total', { orgId, channel: 'confirmation' });
    return sent;
  } catch (err) {
    logger.warn('Recipient confirmation email failed', { orgId, error: errorMessage(err) });
    emitCounter('report_delivery_failed_total', { orgId, channel: 'confirmation' });
    return false;
  }
}

/** Email one message to the definition's owner, if this instance can send mail. */
async function emailOwner(definition: ReportDefinition, subject: string, text: string): Promise<void> {
  if (!(await emailAvailable())) return;
  try {
    // The TENANT leg, not the report leg: the owner is a platform user, so platform
    // resolves the address from the directory and reporting never handles it.
    await platform().post('/internal/notify-email', {
      orgId: definition.orgId,
      targetUsers: [definition.ownerId],
      subject,
      text,
    }, {
      headers: {
        Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId: definition.orgId, role: 'member' }),
      },
    });
  } catch (err) {
    logger.warn('Owner notification email failed', { orgId: definition.orgId, error: errorMessage(err) });
  }
}
