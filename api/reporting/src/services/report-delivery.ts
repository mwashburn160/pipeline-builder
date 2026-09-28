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
  type ReportRecipient,
  type ReportRun,
} from '@pipeline-builder/pipeline-data';
import { publicBaseUrl as baseUrl, REPORTING_HTTP_TIMEOUT_MS } from '../helpers/report-helpers.js';

const logger = createLogger('report-delivery');

/** How long the instance-wide email switch is cached. */
const EMAIL_STATUS_TTL_MS = 60_000;

/** Per-destination delivery budget. A slow Slack must not hold up the next run. */
const DESTINATION_TIMEOUT_MS = 5_000;

/** What one delivery attempt produced, for the run log and the metrics. */
export interface DeliveryOutcome {
  /** In-app notifications persisted. */
  inApp: number;
  email: { sent: number; failed: number; skipped: number };
  destinations: { delivered: number; failed: number };
  /** False ⇒ email was not attempted at all, and the report went in-app only. */
  emailAvailable: boolean;
  /** Anything the lead should know about this delivery, in plain words. */
  notes: string[];
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
 */
export async function deliverPublishedRun(
  definition: ReportDefinition,
  run: ReportRun,
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = {
    inApp: 0,
    email: { sent: 0, failed: 0, skipped: 0 },
    destinations: { delivered: 0, failed: 0 },
    emailAvailable: false,
    notes: [],
  };
  const headline = headlineOf(run);
  const subject = `${definition.name} — ${run.periodLabel}`;

  // 1. In-app, first and unconditionally. It is the channel that cannot be
  // misconfigured, so a report is never delivered nowhere.
  if (await sendSystemNotification({
    recipientOrgId: definition.orgId,
    subject,
    content: emailBody(definition, run, headline),
    priority: 'normal',
  })) {
    outcome.inApp += 1;
  } else {
    outcome.notes.push('The in-app notification could not be posted.');
  }

  // 2. Email, to verified recipients only.
  outcome.emailAvailable = await emailAvailable();
  const recipients = await stakeholderReportStore.getRecipients(definition.orgId, definition.recipients);
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
    outcome.email.sent = result.sent.length;
    outcome.email.failed = result.failed.length;
    // Each refused address is a bounce against that recipient, not a failed run.
    for (const email of result.failed) {
      const count = await stakeholderReportStore.recordBounce(definition.orgId, email);
      if (count >= MAX_BOUNCES) {
        outcome.notes.push(`One recipient address has now bounced ${count} times and will be skipped.`);
      }
    }
  }

  // 3. The org's own Slack / Teams / webhook destinations.
  const fanOut = await deliverToDestinations(definition, run, subject, headline);
  outcome.destinations = fanOut;

  emitCounter('report_delivered_total', {
    orgId: definition.orgId,
    cadence: definition.cadence,
  });
  return outcome;
}

/** POST the report to platform's relay, one message per address. */
async function sendReportEmail(
  definition: ReportDefinition,
  run: ReportRun,
  recipients: readonly ReportRecipient[],
  subject: string,
  headline: string | null,
): Promise<{ sent: string[]; failed: string[] }> {
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
      return { sent: [], failed: [] };
    }
    const strings = (v: unknown): string[] =>
      (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { sent: strings(d.sent), failed: strings(d.failed) };
  } catch (err) {
    logger.warn('Report email relay unreachable', { orgId: definition.orgId, error: errorMessage(err) });
    emitCounter('report_delivery_failed_total', { orgId: definition.orgId, channel: 'email' });
    return { sent: [], failed: [] };
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
): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  const targets = (await listEnabledAlertDestinations(definition.orgId))
    .filter((d) => d.channel === 'slack' || d.channel === 'webhook');
  if (targets.length === 0) return { delivered, failed };

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
      if (res.ok) {delivered += 1;} else {
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
  return { delivered, failed };
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
 * Tell the lead their definition was PAUSED, and which of the three reasons it was.
 *
 * The reason matters more than the pause: an entitlement lapse is a billing
 * conversation, a deactivated owner is a handover, and a lost permission is an admin
 * question. A single "paused" notice would send all three to the wrong person.
 */
export async function notifyPaused(
  definition: ReportDefinition,
  reason: 'entitlement' | 'owner_inactive' | 'permission_lost',
): Promise<void> {
  const why = {
    entitlement: 'the Stakeholder Reports add-on is no longer active on this account',
    owner_inactive: 'the report\'s owner is no longer an active member of this organization',
    permission_lost: 'the report\'s owner no longer holds the permission needed to author reports',
  }[reason];
  const subject = `${definition.name} is paused`;
  const body = [
    `${definition.name} has stopped running because ${why}.`,
    '',
    'Published reports and existing share links are unaffected. Resolve the cause and',
    'resume the report to start it again.',
    '',
    `${baseUrl()}/reports?tab=stakeholder`,
  ].join('\n');
  // To the ORG inbox as well as the owner: two of the three reasons are things the owner
  // cannot fix, and one of them is that the owner is gone.
  await sendSystemNotification({
    recipientOrgId: definition.orgId,
    subject,
    content: body,
    priority: 'high',
  });
  emitCounter('report_definition_paused_total', { orgId: definition.orgId, reason });
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
