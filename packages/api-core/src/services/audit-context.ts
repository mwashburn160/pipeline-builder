// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient audit context: the request/job facts every audit event should carry
 * (request id, trace id, client ip / user agent, the verified principal's
 * credential, inbound correlation ids) without each of the ~150 `recordAudit`
 * call sites threading them through by hand.
 *
 * api-server's request pipeline opens a scope per inbound request
 * (`auditContextFromRequest` + `runWithAuditContext`); background work opens its
 * own with `runWithAuditContext({ job: { jobId, runId, trigger } }, fn)`. The
 * remote-audit client reads the scope when an event is RECORDED and stamps the
 * result onto the event itself, so a spooled re-delivery minutes later still
 * carries the context of the moment it happened.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { Request } from 'express';
import { serviceNameOf } from '../middleware/service-tokens.js';
import { isSystemOrgId } from '../middleware/system-org.js';
import type { JwtPayload } from '../types/common.js';

/** Inbound correlation ids a caller (CLI, Lambda, CodeBuild) may forward. */
export interface AuditCorrelation {
  /** `X-Pipeline-Execution-Id` — the CodePipeline execution that made the call. */
  pipelineExecutionId?: string;
  /** `X-CodeBuild-Build-Id` — the CodeBuild build that made the call. */
  codebuildBuildId?: string;
  /** `X-Source-Event-Id` — the upstream event (EventBridge / webhook) being handled. */
  sourceEventId?: string;
}

/** Background-work identity for events recorded outside any request. */
export interface AuditJobContext {
  /** Stable job name (e.g. `registry-gc`, `vuln-rescan`). */
  jobId?: string;
  /** This run's id (a BullMQ job id, a sweep's uuid). */
  runId?: string;
  /** What started it: `schedule`, `queue`, `startup`, `manual`, … */
  trigger?: string;
}

export interface AuditContext {
  requestId?: string;
  traceId?: string;
  ip?: string;
  userAgent?: string;
  correlation?: AuditCorrelation;
  job?: AuditJobContext;
  /**
   * The VERIFIED principal of the inbound request. A getter, not a value: the
   * scope opens before `requireAuth` runs, so `req.user` is read at the moment
   * an event is recorded.
   */
  principal?: () => JwtPayload | undefined;
}

/**
 * The credential behind an audited action — reserved `details._auth`, so it is
 * covered by the audit hash chain (which hashes `details`). Built only from a
 * verified token, never from caller input; the remote-audit client overwrites
 * any `_auth` a call site put in `details`.
 */
export interface AuditAuthBlock {
  principalType?: string;
  /** The internal service, when the principal is a service token. */
  service?: string;
  /**
   * The revocable credential: the access key (PAT / service-account key) the
   * token derives from (`parentKeyId`), else the token's own `jti` (an exchanged
   * key token's key id, an impersonation session id, a service mint id).
   */
  keyId?: string;
  /** Refresh-session slot the token was minted on. */
  sid?: string;
  scope?: string;
  tokenUse?: string;
  /** The token's permissions were narrowed to a subset at credential creation. */
  permissionsRestricted?: true;
  /** The principal is a platform superadmin. */
  superAdmin?: true;
  /**
   * The principal's active org is the system org (vendor staff acting through a
   * system-org job Role). With `superAdmin`, this is what lets the remote-audit
   * client claim a cross-org `affectedOrgId` (see `auditCrossOrg`).
   */
  systemOrg?: true;
}

const storage = new AsyncLocalStorage<AuditContext>();

/**
 * Run `fn` inside an audit-context scope. Nested scopes MERGE onto the outer
 * one (a job started inside a request keeps the request's id), with the inner
 * fields winning.
 */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  const outer = storage.getStore();
  const merged: AuditContext = outer
    ? { ...outer, ...ctx, correlation: ctx.correlation ?? outer.correlation, job: ctx.job ? { ...outer.job, ...ctx.job } : outer.job }
    : ctx;
  return storage.run(merged, fn);
}

/** The active audit context, or undefined outside any scope. */
export function currentAuditContext(): AuditContext | undefined {
  return storage.getStore();
}

/** Inbound correlation headers recorded into the audit context. */
export const AUDIT_CORRELATION_HEADERS = {
  pipelineExecutionId: 'x-pipeline-execution-id',
  codebuildBuildId: 'x-codebuild-build-id',
  sourceEventId: 'x-source-event-id',
} as const;

/** Max length of a stored correlation id / request id. */
const MAX_CORRELATION_LEN = 128;
/** Ids are opaque tokens: uuids, `project:uuid` build ids, ULIDs. Nothing else is stored. */
const CORRELATION_ID = /^[A-Za-z0-9._:/@+=-]+$/;
/** A bare AWS account id. */
const BARE_ACCOUNT_ID = /^\d{12}$/;

/** Max stored User-Agent length — a hostile header must not bloat audit rows. */
const MAX_USER_AGENT_LEN = 512;
/** C0 + DEL + C1 control characters, replaced so a UA can't inject into the UI/CSV export. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

function firstHeader(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Validate an inbound correlation id (`X-Request-Id`, `X-CodeBuild-Build-Id`, …):
 * a bounded opaque token, else `undefined` — an invalid value is dropped, never
 * truncated into something that looks like a different id.
 *
 * No AWS account id is ever stored: an ARN (a CodeBuild build ARN, say) has its
 * account segment emptied, and a bare 12-digit value is refused. The generic
 * 12-digit-run scrub is NOT used here — it would redact the all-digit final
 * group of roughly one uuid in three hundred, corrupting the id it exists to
 * correlate.
 */
export function sanitizeCorrelationId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_CORRELATION_LEN || !CORRELATION_ID.test(value)) return undefined;
  if (BARE_ACCOUNT_ID.test(value)) return undefined;
  if (/^arn:/i.test(value)) {
    const parts = value.split(':');
    if (parts.length > 4) parts[4] = '';
    return parts.join(':');
  }
  return value;
}

/** Strip control characters from a User-Agent and cap its length; undefined when empty. */
export function sanitizeUserAgent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const cleaned = raw.replace(CONTROL_CHARS, ' ').trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, MAX_USER_AGENT_LEN);
}

/**
 * The audit context for an inbound request. `requestId` is the id the
 * request-id middleware resolved (validated inbound `X-Request-Id`, else a fresh
 * uuid); the principal is read lazily from `req.user` (auth runs later in the
 * chain).
 */
export function auditContextFromRequest(req: Request, ids: { requestId?: string; traceId?: string } = {}): AuditContext {
  const correlation: AuditCorrelation = {};
  for (const [field, header] of Object.entries(AUDIT_CORRELATION_HEADERS) as Array<[keyof AuditCorrelation, string]>) {
    const value = sanitizeCorrelationId(firstHeader(req.headers[header]));
    if (value) correlation[field] = value;
  }
  return {
    requestId: ids.requestId,
    traceId: ids.traceId,
    ip: req.ip,
    userAgent: sanitizeUserAgent(firstHeader(req.headers['user-agent'])),
    correlation: Object.keys(correlation).length > 0 ? correlation : undefined,
    principal: () => req.user,
  };
}

/** The `_auth` block for a verified principal (undefined when there is none). */
export function auditAuthBlock(user: JwtPayload | undefined): AuditAuthBlock | undefined {
  if (!user) return undefined;
  const block: AuditAuthBlock = {
    principalType: user.principalType,
    service: serviceNameOf(user),
    keyId: user.parentKeyId ?? user.jti,
    sid: user.sid,
    scope: user.scope,
    tokenUse: user.token_use,
    ...(user.permissionsRestricted === true ? { permissionsRestricted: true as const } : {}),
    ...(user.isSuperAdmin === true ? { superAdmin: true as const } : {}),
    // A SERVICE token in the system org is the platform's own plumbing, not staff
    // acting on a tenant; only human / service-account principals count.
    ...(user.principalType !== 'service' && isSystemOrgId(user.organizationId) ? { systemOrg: true as const } : {}),
  };
  for (const key of Object.keys(block) as Array<keyof AuditAuthBlock>) {
    if (block[key] === undefined) delete block[key];
  }
  return Object.keys(block).length > 0 ? block : undefined;
}
