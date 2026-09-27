// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance and access posture for a report, read over service-to-service calls.
 *
 * Neither number is reporting's to compute. Compliance owns the rules and the scan
 * results; platform owns members, MFA, SSO, service accounts and API keys. Reporting
 * asks, and does not keep a copy — a cached posture is a posture that can be stale in
 * precisely the direction that matters ("MFA coverage 100%" a week after somebody
 * turned it off).
 *
 * BOTH LEGS DEGRADE, INDEPENDENTLY. An unreachable compliance service makes the
 * compliance half say so and leaves the access half intact, and vice versa. That is
 * the whole reason this section is optional on the data source: a weekly report that
 * did not arrive because one optional panel's upstream was down is a support ticket,
 * whereas a panel that says it could not be computed is information.
 *
 * WHAT IS DELIBERATELY NOT HERE: any per-person field. Not "who has MFA off", not
 * "who made the permission changes" — counts only. A posture panel that names people
 * turns a delivery report into a list of individuals to talk to, which is the failure
 * mode the whole feature is built to avoid.
 */

import {
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  serviceEndpoint,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import { REPORTING_HTTP_TIMEOUT_MS } from '../helpers/report-helpers.js';

const logger = createLogger('report-posture');

/** The compliance half. Counts, over the org's own rules. */
export interface CompliancePosture {
  /** Rules currently active for the org. */
  activeRules: number;
  /** Time-boxed exemptions still in force. */
  activeExemptions: number;
  /** The most recent completed scan's verdict counts, or null if never scanned. */
  lastScan: {
    at: string;
    entities: number;
    passed: number;
    warnings: number;
    blocked: number;
  } | null;
  /** Frameworks the org's rules cite (SOC 2, PCI…), for the header line. */
  frameworks: string[];
}

/** The access half. Counts, never names. */
export interface AccessPosture {
  members: number;
  /** Members with at least one second factor enrolled. */
  membersWithMfa: number;
  /** Whether the org requires SSO for interactive sign-in. */
  ssoRequired: boolean;
  serviceAccounts: number;
  /** API keys that have not expired or been revoked. */
  activeApiKeys: number;
  /** Permission or role changes in the window. A count, and a link to the audit. */
  permissionChanges: number;
}

/** What the section renders. Either half may be absent, with the reason. */
export interface PostureSnapshot {
  compliance: CompliancePosture | null;
  access: AccessPosture | null;
  /** Why a half is missing, in words a manager can read. */
  unavailable?: string[];
}

function client(service: 'compliance' | 'platform'): InternalHttpClient {
  const { host, port } = serviceEndpoint(service);
  return new InternalHttpClient({ host, port });
}

const auth = (orgId: string) => ({
  Authorization: getServiceAuthHeader({ serviceName: 'reporting', orgId, role: 'member' }),
});

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Read the compliance half, or null.
 *
 * The org travels in the TOKEN, not the path: compliance takes the tenant from the
 * caller's identity, so a reporting bug cannot read a second org's posture by
 * building the wrong URL. That is also why this leg mints a per-org token while the
 * platform leg below uses the system-org one — platform's endpoint is explicitly a
 * cross-org read, and says so.
 */
async function readCompliance(orgId: string): Promise<CompliancePosture | null> {
  try {
    const res = await client('compliance').get<{ data?: Record<string, unknown> }>(
      '/compliance/posture',
      { headers: auth(orgId), timeout: REPORTING_HTTP_TIMEOUT_MS },
    );
    const d = res.body?.data;
    if (res.statusCode >= 400 || !d) return null;
    const scan = d.lastScan as Record<string, unknown> | null | undefined;
    return {
      activeRules: num(d.activeRules),
      activeExemptions: num(d.activeExemptions),
      frameworks: strings(d.frameworks),
      lastScan: scan && typeof scan.at === 'string'
        ? {
          at: scan.at,
          entities: num(scan.entities),
          passed: num(scan.passed),
          warnings: num(scan.warnings),
          blocked: num(scan.blocked),
        }
        : null,
    };
  } catch (err) {
    logger.warn('Compliance posture unavailable for report', { orgId, error: errorMessage(err) });
    return null;
  }
}

/** Read the access half from platform, or null. */
async function readAccess(orgId: string, from: string, to: string): Promise<AccessPosture | null> {
  const q = new URLSearchParams({ from, to });
  try {
    const res = await client('platform').get<{ data?: Record<string, unknown> }>(
      `/internal/reporting/access-posture/${encodeURIComponent(orgId)}?${q.toString()}`,
      { headers: auth(SYSTEM_ORG_ID), timeout: REPORTING_HTTP_TIMEOUT_MS },
    );
    const d = res.body?.data;
    if (res.statusCode >= 400 || !d || typeof d.members !== 'number') return null;
    return {
      members: num(d.members),
      membersWithMfa: num(d.membersWithMfa),
      ssoRequired: d.ssoRequired === true,
      serviceAccounts: num(d.serviceAccounts),
      activeApiKeys: num(d.activeApiKeys),
      permissionChanges: num(d.permissionChanges),
    };
  } catch (err) {
    logger.warn('Access posture unavailable for report', { orgId, error: errorMessage(err) });
    return null;
  }
}

/**
 * Both halves, in parallel, each degrading on its own.
 *
 * `Promise.all` over two calls that cannot reject: each leg already turns every
 * failure into `null`, so one slow upstream costs one panel half and never the run.
 */
export async function readPosture(orgId: string, from: string, to: string): Promise<PostureSnapshot> {
  const [compliance, access] = await Promise.all([readCompliance(orgId), readAccess(orgId, from, to)]);
  const unavailable: string[] = [];
  if (!compliance) unavailable.push('Compliance posture could not be read for this report.');
  if (!access) unavailable.push('Access posture could not be read for this report.');
  return {
    compliance,
    access,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}
