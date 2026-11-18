// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Everything ops-center needs from platform (the identity hub), each call
 * through a typed internal contract (api-core `PLATFORM_INTERNAL`):
 *
 *  - `orgAccountRoot` — an org's account root, for feature-quota reservations;
 *  - `auditActivity` — the audit-trail aggregations the Audit Activity panels
 *    render (the trail is platform's Mongo, which ops-center never opens);
 *  - `notifyEmail` — the email relay: the alert leg for `email` destinations,
 *    the tenant leg for the "your destination keeps failing" notice to the
 *    org's admins (recipients resolved by platform, which owns the directory);
 *  - `notifyEmailStatus` — whether this deployment can send email at all;
 *  - `liveOrgIds` — the live org ids a sysadmin's `orgs=all` log view enumerates.
 *
 * Every call carries an ops-center service token. The email legs are
 * tenant-bound, so their token is minted for the org the mail is about.
 */

import {
  callInternal,
  createLogger,
  createSafeClient,
  errorMessage,
  getServiceAuthHeader,
  PLATFORM_INTERNAL,
  serviceEndpoint,
  SYSTEM_ORG_ID,
  type AuditActivityResultData,
  type ContractBody,
} from '@pipeline-builder/api-core';

const SERVICE = 'ops-center';
const logger = createLogger('platform-client');

/** Per-call timeout. Every caller is on a request path or a best-effort notice. */
const PLATFORM_TIMEOUT_MS = 5000;

function client() {
  const { host, port } = serviceEndpoint('platform');
  return createSafeClient({ host, port, timeout: PLATFORM_TIMEOUT_MS });
}

function headers(orgId: string): Record<string, string> {
  return { Authorization: getServiceAuthHeader({ serviceName: SERVICE, orgId, role: 'member' }) };
}

/** Thrown when platform could not answer a call this service cannot do without. */
export class PlatformUnavailableError extends Error {
  constructor(contractId: string, detail: string) {
    super(`platform ${contractId} failed: ${detail}`);
    this.name = 'PlatformUnavailableError';
  }
}

function failure(result: { ok: false; reason: string; status?: number }): string {
  return result.reason === 'status' ? `HTTP ${result.status}` : result.reason;
}

/**
 * The account root of `orgId`. Throws {@link PlatformUnavailableError} when
 * platform cannot say — a reservation against a GUESSED root (the team itself)
 * would let a team past the account's pooled cap.
 */
export async function resolveAccountRoot(orgId: string): Promise<string> {
  const result = await callInternal(client(), PLATFORM_INTERNAL.orgAccountRoot, {
    params: { orgId },
    options: { headers: headers(SYSTEM_ORG_ID) },
  });
  if (!result.ok) throw new PlatformUnavailableError(PLATFORM_INTERNAL.orgAccountRoot.id, failure(result));
  return result.data.rootOrgId;
}

export type AuditActivityRequest = ContractBody<typeof PLATFORM_INTERNAL.auditActivity>;

/** One audit-activity aggregation. Throws when platform cannot answer (the panel's slot 500s). */
export async function queryAuditActivity(body: AuditActivityRequest): Promise<AuditActivityResultData> {
  const result = await callInternal(client(), PLATFORM_INTERNAL.auditActivity, {
    body,
    options: { headers: headers(SYSTEM_ORG_ID) },
  });
  if (!result.ok) throw new PlatformUnavailableError(PLATFORM_INTERNAL.auditActivity.id, failure(result));
  return result.data;
}

/** Send one alert email to one configured address. Resolves false on any failure. */
export async function sendAlertEmail(input: { orgId: string; to: string; subject: string; text: string }): Promise<boolean> {
  try {
    const result = await callInternal(client(), PLATFORM_INTERNAL.notifyEmail, {
      body: { alertEmail: true, ...input },
      options: { headers: headers(input.orgId) },
    });
    return result.ok && result.data.ok !== false;
  } catch (err) {
    logger.warn('Alert email relay call failed', { orgId: input.orgId, error: errorMessage(err) });
    return false;
  }
}

/** Email an org's active owners/admins (platform resolves them). Resolves false on any failure. */
export async function notifyOrgAdmins(input: { orgId: string; subject: string; text: string }): Promise<boolean> {
  try {
    const result = await callInternal(client(), PLATFORM_INTERNAL.notifyEmail, {
      body: { orgId: input.orgId, subject: input.subject, text: input.text },
      options: { headers: headers(input.orgId) },
    });
    return result.ok && result.data.ok !== false;
  } catch (err) {
    logger.warn('Org-admin notice relay call failed', { orgId: input.orgId, error: errorMessage(err) });
    return false;
  }
}

/** Whether platform can send email (EMAIL_ENABLED); null when it could not be asked. */
export async function fetchEmailEnabled(): Promise<boolean | null> {
  const result = await callInternal(client(), PLATFORM_INTERNAL.notifyEmailStatus, {
    options: { headers: headers(SYSTEM_ORG_ID) },
  });
  return result.ok ? result.data.enabled : null;
}

/** Live org ids in id order, at most `limit`. Throws when platform cannot answer. */
export async function listLiveOrgIds(limit: number): Promise<string[]> {
  const result = await callInternal(client(), PLATFORM_INTERNAL.liveOrgIds, {
    query: { limit },
    options: { headers: headers(SYSTEM_ORG_ID) },
  });
  if (!result.ok) throw new PlatformUnavailableError(PLATFORM_INTERNAL.liveOrgIds.id, failure(result));
  return result.data.orgIds;
}
