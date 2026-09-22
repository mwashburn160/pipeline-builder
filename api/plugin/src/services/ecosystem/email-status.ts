// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether platform can send email (docs/plans/plugin-ecosystem.md §4.2, D1,
 * E6): anonymous submissions are unavailable unless outbound email is
 * configured — the magic link is the submitter's only verification. Read from
 * platform's `GET /internal/notify-email/status` (callers: `plugin`), cached
 * for {@link EMAIL_STATUS_TTL_MS}. FAILS CLOSED: an unreachable platform or an
 * unreadable answer counts as "email off".
 */

import { createLogger, errorMessage, getServiceAuthHeader, InternalHttpClient, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('ecosystem-email-status');

/** How long one answer is trusted. */
export const EMAIL_STATUS_TTL_MS = 60_000;

type Probe = () => Promise<boolean>;

const httpProbe: Probe = async () => {
  const { services } = Config.get('server');
  const client = new InternalHttpClient({ host: services.platformHost, port: services.platformPort, timeout: 5_000 });
  const res = await client.get<{ data?: { enabled?: unknown }; enabled?: unknown }>('/internal/notify-email/status', {
    headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) },
    maxRetries: 0,
  });
  if (res.statusCode >= 400) return false;
  const body = res.body ?? {};
  return (body.data?.enabled ?? body.enabled) === true;
};

let probe: Probe = httpProbe;
let cached: { enabled: boolean; at: number } | null = null;

/** Whether outbound email is configured on platform (cached, fail-closed). */
export async function isOutboundEmailEnabled(now: number = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < EMAIL_STATUS_TTL_MS) return cached.enabled;
  let enabled = false;
  try {
    enabled = await probe();
  } catch (err) {
    logger.warn('Email status unreadable; anonymous submissions treated as unavailable', { error: errorMessage(err) });
  }
  cached = { enabled, at: now };
  return enabled;
}

/** Test hook: replace the platform probe (pass nothing to restore the live one) and drop the cache. */
export function setEmailStatusProbeForTests(fn?: Probe): void {
  probe = fn ?? httpProbe;
  cached = null;
}
