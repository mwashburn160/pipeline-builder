// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM request handling shared by Users and Groups: the wire shapes, the
 * per-request context and its downgrade gate, `eq` filters, pagination and
 * PATCH operation parsing.
 */

import {
  scimInvalidFilter,
  scimInvalidSyntax,
  scimInvalidValue,
  scimNotEntitled,
} from './scim-errors.js';
import { SCIM_DEFAULT_COUNT, SCIM_MAX_COUNT } from '../constants/scim.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails: Array<{ value: string; type: 'work'; primary: true }>;
  active: boolean;
  groups: Array<{ value: string; display: string; type: 'direct' }>;
  meta: ScimMeta;
}

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: Array<{ value: string; display: string; type: 'User' }>;
  meta: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** One PATCH operation (RFC 7644 §3.5.2). */
export interface ScimPatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

/** Query parameters every list endpoint accepts. */
export interface ScimListQuery {
  filter?: string;
  startIndex?: string;
  count?: string;
}

/**
 * What a write actually did, for the audit row and the metric. The controller
 * turns `action` into the audit action; `changed` names the attributes that
 * moved, never their values.
 */
export interface ScimWriteOutcome<T> {
  resource: T;
  action: 'create' | 'update' | 'activate' | 'deactivate' | 'delete' | 'members';
  changed: string[];
  /** Users whose Role set the write reconciled (audited as the blast radius). */
  affectedUserIds?: string[];
}

/**
 * The org a SCIM request acts on, plus whether it still holds the entitlement.
 * Built once per request by the controller from the VERIFIED token, so nothing
 * below ever reads an org id from the path or the body.
 */
export interface ScimContext {
  orgId: string;
  /** The org's live `sso` entitlement. False ⇒ removal-only (see the header). */
  entitled: boolean;
}

/** What a write is trying to do, for the post-downgrade asymmetry. */
export type ScimIntent = 'create' | 'update' | 'deactivate' | 'delete';

/**
 * The downgrade gate, in one place: after the entitlement lapses, only writes
 * that REMOVE access are accepted. Reads never reach here — an IdP has to look a
 * user up before it can deactivate them, so refusing GET would break the very
 * path this asymmetry exists to keep working.
 */
export function assertIntentAllowed(ctx: ScimContext, intent: ScimIntent): void {
  if (ctx.entitled) return;
  if (intent === 'deactivate' || intent === 'delete') return;
  throw scimNotEntitled();
}

// ---------------------------------------------------------------------------
// Filter + pagination parsing
// ---------------------------------------------------------------------------

/** `attr eq "value"` (and the unquoted `attr eq true` Okta sends for `active`) —
 *  the only filter form the plan requires, and the only one Okta/Entra send for
 *  the provisioning flows. Anything else is refused with `invalidFilter` rather
 *  than silently returning everything, which would make an IdP conclude a user
 *  doesn't exist and create a duplicate. */
const EQ_FILTER = /^\s*([A-Za-z][\w.]*)\s+eq\s+(?:"((?:[^"\\]|\\.)*)"|(true|false))\s*$/i;

export interface ParsedFilter {
  attribute: string;
  value: string;
}

/** Parse a supported `eq` filter, or undefined when the client sent none. */
export function parseScimFilter(filter: string | undefined, supported: readonly string[]): ParsedFilter | undefined {
  if (filter === undefined || filter.trim() === '') return undefined;
  const m = EQ_FILTER.exec(filter);
  if (!m) {
    throw scimInvalidFilter(`Unsupported filter. This endpoint supports only: ${supported.map((a) => `${a} eq "…"`).join(', ')}`);
  }
  const attribute = m[1];
  if (!supported.some((s) => s.toLowerCase() === attribute.toLowerCase())) {
    throw scimInvalidFilter(`Filtering on '${attribute}' is not supported. Supported attributes: ${supported.join(', ')}`);
  }
  // Unescape the two sequences JSON-ish SCIM filter strings may carry.
  const raw = m[2] !== undefined ? m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : m[3];
  return { attribute: attribute.toLowerCase(), value: raw };
}

/** 1-based `startIndex` + bounded `count` (RFC 7644 §3.4.2.4). Out-of-range
 *  values are CLAMPED, never refused: the RFC says a startIndex < 1 is
 *  interpreted as 1, and a negative count as zero. */
export function parseScimPagination(query: ScimListQuery): { skip: number; limit: number; startIndex: number } {
  const rawStart = Number.parseInt(query.startIndex ?? '', 10);
  const startIndex = Number.isFinite(rawStart) && rawStart > 1 ? rawStart : 1;
  const rawCount = Number.parseInt(query.count ?? '', 10);
  const limit = Number.isFinite(rawCount)
    ? Math.max(0, Math.min(rawCount, SCIM_MAX_COUNT))
    : SCIM_DEFAULT_COUNT;
  return { skip: startIndex - 1, limit, startIndex };
}

// ---------------------------------------------------------------------------
// PATCH operations
// ---------------------------------------------------------------------------

/** Value of a PATCH op, tolerating both `{path:'active', value:false}` and the
 *  path-less `{value:{active:false}}` form every major IdP also emits. */
export function patchPairs(op: ScimPatchOperation): Array<[string, unknown]> {
  if (typeof op.path === 'string' && op.path.trim() !== '') return [[op.path.trim(), op.value]];
  if (op.value && typeof op.value === 'object' && !Array.isArray(op.value)) return Object.entries(op.value as Record<string, unknown>);
  throw scimInvalidSyntax('Each PATCH operation must carry a `path`, or a `value` object of attributes.');
}

/** Coerce the many spellings of a boolean an IdP may send for `active`. */
export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  throw scimInvalidValue('`active` must be a boolean.');
}

/**
 * Validate a PatchOp's `Operations` (RFC 7644 §3.5.2): a non-empty array whose
 * every op is `add`, `replace` or `remove` (case-insensitive). Returns each
 * operation with its op normalized.
 */
export function normalizePatchOps(ops: unknown): Array<{ op: 'add' | 'replace' | 'remove'; raw: ScimPatchOperation }> {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw scimInvalidSyntax('A PatchOp must carry a non-empty `Operations` array.');
  }
  return (ops as ScimPatchOperation[]).map((raw) => {
    const op = String(raw?.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove') {
      throw scimInvalidSyntax(`Unsupported PATCH op '${raw?.op}'. Use add, replace or remove.`);
    }
    return { op, raw };
  });
}
