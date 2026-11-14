// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Token-forwarding client for the agent's read/propose tools. The "Ask" agent acts
// STRICTLY on behalf of the calling user by forwarding their bearer token to the
// existing service routes, so compliance, quota, permissions, and tenancy apply
// exactly as they do for the user's own requests. Exactly ONE call leaves on
// ask's own service identity instead — `readInstanceEmailStatus` at the bottom,
// which reads a single instance-wide boolean that carries no tenant data at all;
// every other call in this file is the caller's, and a new one must stay so.
//
// Every forwarded call also carries ask's signed ON-BEHALF marker (api-core
// `onBehalfHeaders`, bound to the caller and org): the agent turn was already
// metered (and AI-reserved) when it arrived here, so the peer's apiCalls meter
// and check skip the hop instead of billing the user 10-20 calls per turn. It
// waives the call budget only — the peer's tenancy, permission and reservation
// gates (a delegated `/generate` still reserves its own aiCalls slot) apply.
// Base URLs come from the typed `server.services` config (PIPELINE_SERVICE_HOST/PORT,
// PLUGIN_SERVICE_HOST/PORT, PLATFORM_SERVICE_HOST/PORT, COMPLIANCE_SERVICE_HOST/PORT,
// REPORTING_SERVICE_HOST/PORT, QUOTA_SERVICE_HOST/PORT) — the same discovery config
// every other service uses.

import { AI_REQUEST_TIMEOUT_MS } from '@pipeline-builder/ai-core';
import { createLogger, currentAuditContext, envInt, errorMessage, getServiceAuthHeader, onBehalfHeaders, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { OnBehalfSubject } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

import { DownstreamError } from './downstream-error.js';

const logger = createLogger('ask-internal-http');

/** Per-call options. */
export interface CallOptions {
  /**
   * `generation`: the call runs a model downstream (`/pipelines/generate`,
   * `/plugins/generate`, …), so it gets {@link GENERATION_TIMEOUT_MS} instead of
   * the ordinary {@link HTTP_TIMEOUT_MS}.
   */
  generation?: boolean;
}

/** Minimal service client that forwards the caller's Authorization header. */
export interface ServiceClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown, opts?: CallOptions): Promise<unknown>;
}

// Per-call timeout so a hung downstream service can't wedge the whole SSE turn
// (the tool `execute` runs inside the model's fullStream await). Mirrors the
// bounded external calls in api/pipeline's git-analysis client.
export const HTTP_TIMEOUT_MS = envInt('ASK_HTTP_TIMEOUT_MS', 30000, { min: 1 });

/**
 * Timeout for a DELEGATED generation. The peer runs a model call bounded by
 * `AI_REQUEST_TIMEOUT_MS` (ai-core) and has already reserved — and, once its
 * provider answered, kept — an `aiCalls` slot; giving up before it can finish
 * charges the user for a draft they never see. So: the AI budget plus a margin
 * for the peer's own work (repository analysis, compliance), never below the
 * ordinary timeout.
 */
export const GENERATION_TIMEOUT_MS = Math.max(HTTP_TIMEOUT_MS, AI_REQUEST_TIMEOUT_MS + 30_000);

/** The peer's `code` from an error body, when it is a plain upper-snake identifier. */
async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    // api-core `sendError` puts the ErrorCode at the top level.
    const code = ((await res.json()) as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param signal - the turn's own abort signal (client disconnect). Every call is
 *   cancelled with the turn, so a closed panel stops the downstream work too.
 */
function makeClient(baseUrl: string, authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const headers = { 'Content-Type': 'application/json', 'Authorization': authHeader };
  const call = async (path: string, init: RequestInit, opts: CallOptions = {}): Promise<unknown> => {
    const timeout = AbortSignal.timeout(opts.generation ? GENERATION_TIMEOUT_MS : HTTP_TIMEOUT_MS);
    // The turn's request id rides every downstream call, so the pipeline/plugin
    // generation, compliance check or quota read a turn caused is correlatable
    // with the `ask.*` audit row in the logs and the downstream audit trail. Read
    // per call from the ambient audit context (the agent's tools run inside it).
    const requestId = currentAuditContext()?.requestId;
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      // The marker is minted per call (it expires in 120 s; a turn can run longer).
      headers: { ...headers, ...(onBehalf ? onBehalfHeaders(onBehalf) : {}), ...(requestId ? { 'X-Request-Id': requestId } : {}), ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      // Status only — never the downstream body. The error text reaches the
      // model as a tool result (and can surface to the user); an internal
      // service's error body can carry stack traces, SQL, internal ids or
      // another request's details. A 429's `code` alone is read, so a tool can
      // say WHICH limit refused it (see `quotaRefusalMessage`).
      const code = res.status === 429 ? await errorCodeOf(res) : undefined;
      throw new DownstreamError(`${init.method ?? 'GET'} ${path} -> ${res.status}`, res.status, code);
    }
    return res.json();
  };
  return {
    get: (path) => call(path, { method: 'GET' }),
    post: (path, body, opts) => call(path, { method: 'POST', body: JSON.stringify(body) }, opts),
  };
}

/** Client for the pipeline service (`/pipelines/*`), forwarding the user token. */
export function pipelineClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { pipelineHost, pipelinePort } = Config.get('server').services;
  return makeClient(`http://${pipelineHost}:${pipelinePort}`, authHeader, onBehalf, signal);
}

/** Client for the plugin service (`/plugins/*`), forwarding the user token. */
export function pluginClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { pluginHost, pluginPort } = Config.get('server').services;
  return makeClient(`http://${pluginHost}:${pluginPort}`, authHeader, onBehalf, signal);
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
export function platformClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { platformHost, platformPort } = Config.get('server').services;
  return makeClient(`http://${platformHost}:${platformPort}`, authHeader, onBehalf, signal);
}

/** Client for the compliance service (`/compliance/*`), forwarding the user token. */
export function complianceClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { complianceHost, compliancePort } = Config.get('server').services;
  return makeClient(`http://${complianceHost}:${compliancePort}`, authHeader, onBehalf, signal);
}

/** Client for the reporting service (`/reports/*`), forwarding the user token. */
export function reportingClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { reportingHost, reportingPort } = Config.get('server').services;
  return makeClient(`http://${reportingHost}:${reportingPort}`, authHeader, onBehalf, signal);
}

/** Client for the quota service (`/quotas`), forwarding the user token. */
export function quotaClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { quotaHost, quotaPort } = Config.get('server').services;
  return makeClient(`http://${quotaHost}:${quotaPort}`, authHeader, onBehalf, signal);
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
