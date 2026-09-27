// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * When a member leaves an organization, the stakeholder reports they OWN have to
 * stop, and somebody has to be told.
 *
 * A scheduled report is authorized as its owner, so a definition owned by a
 * deactivated account would keep computing numbers with access that account no
 * longer has. The reporting service pauses them; this module drives that and then
 * notifies the org's admins, because a silently stopped weekly report is otherwise
 * discovered by a manager not receiving it.
 *
 * FIRE AND FORGET. Deactivating a member must not fail because the reporting
 * service is down or slow — the membership change is the operation the admin asked
 * for, and the scheduler re-checks every owner on every run regardless, so the
 * worst case of a missed call here is that the reports stop one cycle later
 * instead of immediately.
 */

import {
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { holdersOfPermission } from './ecosystem-notifications.js';

const logger = createLogger('report-ownership');

/** A report that stopped, as reporting describes it. */
interface PausedReport {
  id: string;
  name: string;
  cadence: string;
}

/** Why the owner can no longer run reports. */
export type ReportPauseCause = 'owner_inactive' | 'permission_lost';

function client(): InternalHttpClient {
  return new InternalHttpClient({
    host: config.reporting.serviceHost,
    port: config.reporting.servicePort,
    timeout: config.reporting.serviceTimeout,
  });
}

/** Ask reporting to pause the definitions this person owns. Returns what stopped. */
async function pauseAtReporting(orgId: string, userId: string, reason: ReportPauseCause): Promise<PausedReport[]> {
  const res = await client().post<{ data?: { paused?: unknown } }>(
    `/reports/stakeholder-internal/owner-left/${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`,
    { reason },
    { headers: { Authorization: getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'member' }) } },
  );
  if (res.statusCode >= 400) throw new Error(`reporting responded ${res.statusCode}`);
  const paused = res.body?.data?.paused;
  if (!Array.isArray(paused)) return [];
  return paused.filter((p): p is PausedReport =>
    !!p && typeof p === 'object'
    && typeof (p as PausedReport).id === 'string'
    && typeof (p as PausedReport).name === 'string');
}

/**
 * Tell the org's admins which reports stopped and that they need a new owner.
 *
 * `org:settings` holders, because that is the org-admin capability every other
 * per-org configuration surface uses — and re-assigning a report's owner is an
 * administrative decision, not the departing member's.
 */
async function notifyAdmins(orgId: string, userId: string, paused: PausedReport[]): Promise<void> {
  const admins = await holdersOfPermission(orgId, 'org:settings');
  if (admins.length === 0) {
    // Nobody holds the capability: log it rather than silently doing nothing, so
    // the gap is visible when someone asks why no notice arrived.
    logger.warn('Reports paused but the organization has no org:settings holder to notify', { orgId, count: paused.length });
    return;
  }
  // Read the name only now that there is something to say — most deactivations own
  // no reports and should cost no extra query.
  const { User } = await import('../models/index.js');
  const user = await User.findById(userId).select('username email').lean() as
    { username?: string; email?: string } | null;
  const displayName = user?.username?.trim() || user?.email || 'A former member';

  const list = paused.map((p) => `• ${p.name} (${p.cadence})`).join('\n');
  const subject = paused.length === 1
    ? 'A scheduled report has been paused'
    : `${paused.length} scheduled reports have been paused`;
  const text = `${displayName} no longer has access to this organization, so the scheduled `
    + `report${paused.length === 1 ? '' : 's'} they owned ${paused.length === 1 ? 'has' : 'have'} been paused:\n\n${list}\n\n`
    + 'A report runs with its owner\'s access, which is why it cannot keep running without one. '
    + 'Transfer it to someone who should own it, then resume it — the recipients and the past '
    + 'reports are unchanged.';

  const { sendInAppNotification } = await import('../helpers/in-app-notify.js');
  for (const userId of admins) {
    await sendInAppNotification({ recipientOrgId: orgId, recipientUserId: userId, subject, content: text });
  }
}

/**
 * Pause and announce the reports a departing member owned. Never throws.
 *
 * Called from the member deactivate and remove paths. Deliberately NOT called on
 * re-activation: the pause reason is on the definition for the lead to read, and
 * resuming a report is a decision (the recipients may have changed, the period may
 * be stale), not an automatic consequence of someone's account coming back.
 */
export async function pauseFormerMemberReports(
  orgId: string,
  userId: string,
  reason: ReportPauseCause = 'owner_inactive',
): Promise<void> {
  try {
    const paused = await pauseAtReporting(orgId, userId, reason);
    if (paused.length === 0) return;
    logger.info('Paused a former member’s stakeholder reports', { orgId, userId, count: paused.length });
    await notifyAdmins(orgId, userId, paused);
  } catch (err) {
    // The scheduler's own per-run owner re-check is the backstop, so this is a
    // latency problem, not a correctness one.
    logger.warn('Could not pause a former member’s stakeholder reports; the scheduler will catch it on the next run', {
      orgId,
      userId,
      error: errorMessage(err),
    });
  }
}
