// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Token-forwarding client for the agent's read/propose tools. The "Ask" agent acts
// STRICTLY on behalf of the calling user by forwarding their bearer token to the
// existing service routes, so compliance, quota, permissions, and tenancy apply
// exactly as they do for the user's own requests. Exactly ONE call leaves on
// ask-agent's own service identity instead — `readInstanceEmailStatus` at the bottom,
// which reads a single instance-wide boolean that carries no tenant data at all;
// every other call in this file is the caller's, and a new one must stay so.
//
// Every forwarded call also carries ask-agent's signed ON-BEHALF marker (api-core
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
import {
  buildContractPath,
  createLogger,
  currentAuditContext,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  onBehalfHeaders,
  parseContractResponse,
  PLATFORM_INTERNAL,
  SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import type { OnBehalfSubject } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

import { DownstreamError } from './downstream-error.js';
import { config } from '../config.js';

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
export const HTTP_TIMEOUT_MS = config.http.timeoutMs;

/**
 * Timeout for a DELEGATED generation. The peer runs a model call bounded by
 * `AI_REQUEST_TIMEOUT_MS` (ai-core) and has already reserved — and, once its
 * provider answered, kept — an `aiCalls` slot; giving up before it can finish
 * charges the user for a draft they never see. So: the AI budget plus a margin
 * for the peer's own work (repository analysis, compliance), never below the
 * ordinary timeout.
 */
export const GENERATION_TIMEOUT_MS = Math.max(HTTP_TIMEOUT_MS, AI_REQUEST_TIMEOUT_MS + 30_000);

/**
 * Cap on a downstream response body. A tool result is fed to the model, so a
 * peer answering with an enormous body (a bug, or a list endpoint without a
 * page size) must fail the call rather than buffer it into memory — `res.json()`
 * previously read whatever arrived. Generous for any page a tool asks for.
 */
export const MAX_RESPONSE_BYTES = config.http.maxResponseBytes;

/** The peer's `code` from an error body, when it is a plain upper-snake identifier. */
function errorCodeOf(body: unknown): string | undefined {
  // api-core `sendError` puts the ErrorCode at the top level.
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

/**
 * Settle with `work`, or reject with the signal's reason the moment the turn
 * aborts. api-core's http-client takes no AbortSignal, so an abort releases the
 * TURN immediately but cannot cancel the in-flight socket: that request runs on
 * until it answers or hits its own timeout. A call whose turn is ALREADY aborted
 * is never sent.
 */
function untilAborted<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * @param signal - the turn's own abort signal (client disconnect). Every call is
 *   abandoned with the turn, so a closed panel stops waiting on downstream work.
 */
function makeClient(host: string, port: number, authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  // api-core's shared client: pooled keep-alive sockets, the per-target circuit
  // breaker, and a bounded body. The per-call timeout is passed per request.
  const http = new InternalHttpClient({ host, port, timeout: HTTP_TIMEOUT_MS }, { maxResponseBytes: MAX_RESPONSE_BYTES });
  const call = (method: 'GET' | 'POST', path: string, body: unknown, opts: CallOptions = {}): Promise<unknown> => untilAborted(async () => {
    // The turn's request id rides every downstream call, so the pipeline/plugin
    // generation, compliance check or quota read a turn caused is correlatable
    // with the `ask.*` audit row in the logs and the downstream audit trail. Read
    // per call from the ambient audit context (the agent's tools run inside it).
    const requestId = currentAuditContext()?.requestId;
    const options = {
      // The marker is minted per call (it expires in 120 s; a turn can run longer).
      headers: { Authorization: authHeader, ...(onBehalf ? onBehalfHeaders(onBehalf) : {}) },
      ...(requestId ? { requestId } : {}),
      timeout: opts.generation ? GENERATION_TIMEOUT_MS : HTTP_TIMEOUT_MS,
      // No automatic retries: every call already sits inside a model turn with its
      // own budget, a GET retried twice at 30 s would triple a hung peer's cost,
      // and a 429 is a quota REFUSAL the tool must report (with its code), not a
      // backoff to sit through.
      maxRetries: 0,
      maxRateLimitRetries: 0,
    };
    const res = method === 'GET' ? await http.get(path, options) : await http.post(path, body, options);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      // Status only — never the downstream body. The error text reaches the
      // model as a tool result (and can surface to the user); an internal
      // service's error body can carry stack traces, SQL, internal ids or
      // another request's details. A 429's `code` alone is read, so a tool can
      // say WHICH limit refused it (see `quotaRefusalMessage`).
      const code = res.statusCode === 429 ? errorCodeOf(res.body) : undefined;
      throw new DownstreamError(`${method} ${path} -> ${res.statusCode}`, res.statusCode, code);
    }
    return res.body;
  }, signal);
  return {
    get: (path) => call('GET', path, undefined),
    post: (path, body, opts) => call('POST', path, body, opts),
  };
}

/** Client for the pipeline service (`/pipelines/*`), forwarding the user token. */
export function pipelineClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { pipelineHost, pipelinePort } = Config.get('server').services;
  return makeClient(pipelineHost, pipelinePort, authHeader, onBehalf, signal);
}

/** Client for the plugin service (`/plugins/*`), forwarding the user token. */
export function pluginClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { pluginHost, pluginPort } = Config.get('server').services;
  return makeClient(pluginHost, pluginPort, authHeader, onBehalf, signal);
}

/**
 * Client for the platform service, forwarding the user token.
 *
 * Reachable with a USER token: `/config` (the public instance switches) and
 * `/observability/alert-destinations` + `/organization/*` (the caller's own
 * permissions decide). Platform's `/internal/*` routes are service-token-only
 * and are NOT reachable this way. The ONE internal route this service calls
 * goes through {@link readInstanceEmailStatus}, on ask-agent's own service identity —
 * see the reasoning there.
 */
export function platformClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { platformHost, platformPort } = Config.get('server').services;
  return makeClient(platformHost, platformPort, authHeader, onBehalf, signal);
}

/** Client for the compliance service (`/compliance/*`), forwarding the user token. */
export function complianceClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { complianceHost, compliancePort } = Config.get('server').services;
  return makeClient(complianceHost, compliancePort, authHeader, onBehalf, signal);
}

/** Client for the reporting service (`/reports/*`), forwarding the user token. */
export function reportingClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { reportingHost, reportingPort } = Config.get('server').services;
  return makeClient(reportingHost, reportingPort, authHeader, onBehalf, signal);
}

/** Client for the quota service (`/quotas`), forwarding the user token. */
export function quotaClient(authHeader: string, onBehalf?: OnBehalfSubject, signal?: AbortSignal): ServiceClient {
  const { quotaHost, quotaPort } = Config.get('server').services;
  return makeClient(quotaHost, quotaPort, authHeader, onBehalf, signal);
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
 * one. It is sent with ASK-AGENT'S OWN service token (`wireServiceSecurity('ask-agent')` in
 * index.ts; `SERVICE_NAME=ask-agent` + ask-agent's signing key in every deploy target), not
 * the caller's bearer, because the route is `requireInternalService`. Safe to
 * read on any caller's behalf, and NOT a tenancy hole, because the answer is one
 * instance-wide boolean: no org, no recipient, no provider, nothing the asking
 * member could not be told. Platform's send route does NOT list `ask-agent`, so this
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
      platformHost,
      platformPort,
      getServiceAuthHeader({ serviceName: 'ask-agent', orgId: SYSTEM_ORG_ID, role: 'member' }),
    );
    // Through ask-agent's own client (no retries, the per-call timeout, status → throw),
    // with the path and the reply's shape from the endpoint's contract.
    const status = PLATFORM_INTERNAL.notifyEmailStatus;
    const reply = parseContractResponse(status, await client.get(buildContractPath(status)));
    if (!reply.ok) return 'unknown';
    return reply.value.enabled ? 'enabled' : 'disabled';
  } catch (err) {
    // Logged, because the alternative to a loud failure here is exactly the
    // silent degradation this call was introduced to remove: the diagnosis
    // would quietly fall back to inference and nobody would know.
    logger.warn('Could not read the instance email switch from platform', { error: errorMessage(err) });
    return 'unknown';
  }
}
