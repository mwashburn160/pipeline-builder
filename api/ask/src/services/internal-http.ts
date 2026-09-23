// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Token-forwarding client for the agent's read/propose tools. The "Ask" agent acts
// STRICTLY on behalf of the calling user by forwarding their bearer token to the
// existing service routes, so compliance, quota, permissions, and tenancy apply
// exactly as they do for the user's own requests. Exactly ONE call leaves on
// ask's own service identity instead — `readInstanceEmailStatus` at the bottom,
// which reads a single instance-wide boolean that carries no tenant data at all;
// every other call in this file is the caller's, and a new one must stay so.
// Base URLs come from the typed `server.services` config (PIPELINE_SERVICE_HOST/PORT,
// PLUGIN_SERVICE_HOST/PORT, PLATFORM_SERVICE_HOST/PORT, COMPLIANCE_SERVICE_HOST/PORT,
// REPORTING_SERVICE_HOST/PORT, QUOTA_SERVICE_HOST/PORT) — the same discovery config
// every other service uses.

import { createLogger, envInt, errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('ask-internal-http');

/** Minimal service client that forwards the caller's Authorization header. */
export interface ServiceClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

// Per-call timeout so a hung downstream service can't wedge the whole SSE turn
// (the tool `execute` runs inside the model's fullStream await). Mirrors the
// bounded external calls in api/pipeline's git-analysis client.
const HTTP_TIMEOUT_MS = envInt('ASK_HTTP_TIMEOUT_MS', 30000, { min: 1 });

function makeClient(baseUrl: string, authHeader: string): ServiceClient {
  const headers = { 'Content-Type': 'application/json', 'Authorization': authHeader };
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — never the downstream body. The error text reaches the
      // model as a tool result (and can surface to the user); an internal
      // service's error body can carry stack traces, SQL, internal ids or
      // another request's details.
      throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}`);
    }
    return res.json();
  };
  return {
    get: (path) => call(path, { method: 'GET' }),
    post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}

/** Client for the pipeline service (`/pipelines/*`), forwarding the user token. */
export function pipelineClient(authHeader: string): ServiceClient {
  const { pipelineHost, pipelinePort } = Config.get('server').services;
  return makeClient(`http://${pipelineHost}:${pipelinePort}`, authHeader);
}

/** Client for the plugin service (`/plugins/*`), forwarding the user token. */
export function pluginClient(authHeader: string): ServiceClient {
  const { pluginHost, pluginPort } = Config.get('server').services;
  return makeClient(`http://${pluginHost}:${pluginPort}`, authHeader);
}

/**
 * Client for the platform service, forwarding the user token.
 *
 * Reachable with a USER token: `/config` (the public instance switches) and
 * `/observability/alert-destinations` + `/organization/*` (the caller's own
 * permissions decide). Platform's `/internal/*` routes are service-token-only
 * and are NOT reachable this way. The ONE internal route this service calls
 * goes through {@link readInstanceEmailStatus}, on ask's own service identity —
 * see the reasoning there.
 */
export function platformClient(authHeader: string): ServiceClient {
  const { platformHost, platformPort } = Config.get('server').services;
  return makeClient(`http://${platformHost}:${platformPort}`, authHeader);
}

/** Client for the compliance service (`/compliance/*`), forwarding the user token. */
export function complianceClient(authHeader: string): ServiceClient {
  const { complianceHost, compliancePort } = Config.get('server').services;
  return makeClient(`http://${complianceHost}:${compliancePort}`, authHeader);
}

/** Client for the reporting service (`/reports/*`), forwarding the user token. */
export function reportingClient(authHeader: string): ServiceClient {
  const { reportingHost, reportingPort } = Config.get('server').services;
  return makeClient(`http://${reportingHost}:${reportingPort}`, authHeader);
}

/** Client for the quota service (`/quotas`), forwarding the user token. */
export function quotaClient(authHeader: string): ServiceClient {
  const { quotaHost, quotaPort } = Config.get('server').services;
  return makeClient(`http://${quotaHost}:${quotaPort}`, authHeader);
}

/**
 * How the instance-wide outbound-email switch reads. Three states, not a
 * boolean: `unknown` is what a diagnostic must say when it could not ask.
 */
export type EmailSwitch = 'enabled' | 'disabled' | 'unknown';

/**
 * Read platform's `GET /internal/notify-email/status` — whether this instance
 * can send email at all (EMAIL_ENABLED).
 *
 * THE EXCEPTION to this module's forward-the-caller's-token rule, and the only
 * one. It is sent with ASK'S OWN service token (`wireServiceSecurity('ask')` in
 * index.ts; `SERVICE_NAME=ask` + ask's signing key in every deploy target), not
 * the caller's bearer, because the route is `requireInternalService`. Safe to
 * read on any caller's behalf, and NOT a tenancy hole, because the answer is one
 * instance-wide boolean: no org, no recipient, no provider, nothing the asking
 * member could not be told. Platform's send route does NOT list `ask`, so this
 * identity can read the switch and can never make the instance send mail.
 *
 * Why it matters enough to justify that: `platform/src/utils/email.ts` returns
 * `true` when email is disabled, so every caller — invitations, verification,
 * every notification channel — reports success for a message never attempted.
 * This switch IS the answer to "we configured notifications and nothing
 * arrives", and nothing in the org-facing UI shows it.
 *
 * Uncached on purpose (the plugin service caches its copy 60s): this is read
 * once per diagnosis, and a cached `disabled` served right after an operator
 * turned email ON would be a confidently wrong diagnosis.
 *
 * Never throws — an unreachable platform or a rejected token resolves to
 * `unknown`, which the diagnosis reports AS unknown rather than as disabled.
 */
export async function readInstanceEmailStatus(): Promise<EmailSwitch> {
  const { platformHost, platformPort } = Config.get('server').services;
  try {
    const client = makeClient(
      `http://${platformHost}:${platformPort}`,
      getServiceAuthHeader({ serviceName: 'ask', orgId: SYSTEM_ORG_ID, role: 'member' }),
    );
    const body = (await client.get('/internal/notify-email/status')) as { data?: { enabled?: unknown }; enabled?: unknown };
    const enabled = body?.data?.enabled ?? body?.enabled;
    if (enabled === true) return 'enabled';
    if (enabled === false) return 'disabled';
    return 'unknown';
  } catch (err) {
    // Logged, because the alternative to a loud failure here is exactly the
    // silent degradation this call was introduced to remove: the diagnosis
    // would quietly fall back to inference and nobody would know.
    logger.warn('Could not read the instance email switch from platform', { error: errorMessage(err) });
    return 'unknown';
  }
}
