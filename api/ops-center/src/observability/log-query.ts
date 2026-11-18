// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile a structured log filter into LogQL, and resolve the Loki tenant a
 * request may read.
 *
 * This module is the security boundary for the Logs surface. The browser never
 * sends LogQL — it sends an allow-listed filter, and everything here is either a
 * literal from that allow-list or a quoted string. Two independent invariants:
 *
 *   1. **Tenant** — {@link resolveTenants} derives the `X-Scope-OrgID` header
 *      from the VERIFIED token. Loki enforces it, so even a malformed query
 *      cannot cross orgs. Never read the org from a request header: nginx
 *      injects `x-org-id` on every proxied request, and trusting a proxy header
 *      as authority lets any caller pick its tenant.
 *   2. **Query** — {@link buildLogQL} only ever emits label matchers over a
 *      fixed key set and line filters over quoted literals.
 */

import { looksSensitive } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

/** The tenant holding lines with no org: startup, workers, nginx/postgres. Sysadmin-only. */
export const INFRA_TENANT = '_infra';

/**
 * Most tenants Loki will be asked for in one multi-tenant read. Loki has no
 * "all tenants" wildcard, so a fleet-wide view is an enumeration; past this many
 * the caller must narrow instead of us building an unbounded header.
 */
export const MAX_TENANTS_PER_QUERY = 100;

/**
 * Stream labels a filter may constrain. Anything outside this set is rejected
 * rather than ignored — a silently-dropped filter reads as "no matches" and
 * sends people hunting for a bug that isn't there.
 *
 * Matches what promtail promotes (see any `config/promtail/promtail-config.yml`);
 * `pod`/`container` exist only on the Kubernetes targets, `service_name` on all.
 */
const FILTERABLE_LABELS = [
  'service_name', 'service', 'level', 'pod', 'container', 'event', 'eventCategory', 'actor', 'pluginName',
] as const;
export type FilterableLabel = typeof FILTERABLE_LABELS[number];

/** Structured-metadata / parsed fields filterable AFTER the stream selector. */
const FILTERABLE_FIELDS = ['orgId', 'trace_id', 'requestId'] as const;
export type FilterableField = typeof FILTERABLE_FIELDS[number];

export type TextTerm =
  | { kind: 'include'; value: string }
  | { kind: 'exclude'; value: string }
  | { kind: 'regex'; value: string };

export interface LogFilter {
  labels: Partial<Record<FilterableLabel, string>>;
  fields: Partial<Record<FilterableField, string>>;
  terms: TextTerm[];
}

export class LogQueryError extends Error {}

/** Label VALUES are quoted into LogQL, so reject anything that could escape the quotes. */
const SAFE_VALUE = /^[A-Za-z0-9_.:@/+-]{1,200}$/;
/** Cap regex length: RE2 is linear-time (no ReDoS), but an enormous pattern is still work. */
const MAX_REGEX_LENGTH = 200;
const MAX_TERMS = 8;

/** Escape a value for a LogQL double-quoted string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Which Loki tenants this caller may read, as the `X-Scope-OrgID` value.
 *
 * - A normal member gets exactly their own org. No org on the token ⇒ throw
 *   rather than fall back to something broader.
 * - A system admin may name tenants (`requested`), including {@link INFRA_TENANT};
 *   with none named they get `_infra` alone rather than an implicit firehose.
 */
export function resolveTenants(
  scope: { isSuperAdmin: boolean; orgId?: string },
  requested?: readonly string[],
): string {
  if (!scope.isSuperAdmin) {
    const org = scope.orgId?.trim();
    if (!org || !SAFE_VALUE.test(org)) {
      throw new LogQueryError('No organization on the caller; cannot scope a log query');
    }
    return org;
  }
  const wanted = (requested ?? []).map((t) => t.trim()).filter(Boolean);
  if (wanted.length === 0) return INFRA_TENANT;
  if (wanted.length > MAX_TENANTS_PER_QUERY) {
    throw new LogQueryError(
      `Too many organizations selected (${wanted.length}); narrow the selection to ${MAX_TENANTS_PER_QUERY} or fewer`,
    );
  }
  for (const t of wanted) {
    if (!SAFE_VALUE.test(t)) throw new LogQueryError(`Invalid organization id: ${t}`);
  }
  return [...new Set(wanted)].join('|');
}

/** The always-present anchor matcher (see `config.observability.lokiBaseSelector`). */
function baseSelector(): string {
  return config.observability.lokiBaseSelector;
}

/** Parse the search box into a {@link LogFilter}. Throws {@link LogQueryError} on bad input. */
export function parseLogQuery(raw: string | undefined): LogFilter {
  const filter: LogFilter = { labels: {}, fields: {}, terms: [] };
  if (!raw || !raw.trim()) return filter;
  if (raw.length > 1000) throw new LogQueryError('Query too long');

  // field:value | "quoted phrase" | -"excluded phrase" | /regex/ | bare-term
  const TOKEN = /(-?)(?:([A-Za-z_][A-Za-z0-9_]*):)?(?:"([^"]*)"|\/((?:[^/\\]|\\.)+)\/|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(raw)) !== null) {
    const [, neg, field, quoted, regex, bare] = m;

    if (field) {
      if (neg) throw new LogQueryError(`Negated field filters are not supported: -${field}:`);
      const value = quoted ?? bare ?? '';
      if (!SAFE_VALUE.test(value)) throw new LogQueryError(`Invalid value for "${field}"`);
      if ((FILTERABLE_LABELS as readonly string[]).includes(field)) {
        filter.labels[field as FilterableLabel] = value;
      } else if ((FILTERABLE_FIELDS as readonly string[]).includes(field)) {
        filter.fields[field as FilterableField] = value;
      } else {
        throw new LogQueryError(
          `Unknown filter "${field}". Available: ${[...FILTERABLE_LABELS, ...FILTERABLE_FIELDS].join(', ')}`,
        );
      }
      continue;
    }

    if (regex !== undefined) {
      if (regex.length > MAX_REGEX_LENGTH) throw new LogQueryError('Regex is too long');
      filter.terms.push({ kind: 'regex', value: regex });
      continue;
    }

    const text = quoted ?? bare ?? '';
    if (!text) continue;
    // Refuse a search term that is itself a secret. Masking the RESULT is
    // pointless if the query can confirm a guess: a hit on `sk_live_…` proves
    // the value is present even though the line renders as [REDACTED].
    if (looksSensitive(text)) {
      throw new LogQueryError('That search term looks like a credential. Searching for secrets is not permitted.');
    }
    filter.terms.push({ kind: neg ? 'exclude' : 'include', value: text });
  }

  if (filter.terms.length > MAX_TERMS) throw new LogQueryError(`Too many search terms (max ${MAX_TERMS})`);
  return filter;
}

/**
 * Compile a filter into LogQL.
 *
 * No org predicate is appended: isolation is the tenant header
 * ({@link resolveTenants}), enforced by Loki itself. An `orgId` field filter is
 * still allowed — a sysadmin reading several tenants at once uses it to narrow —
 * but it is a convenience, never the boundary.
 */
export function buildLogQL(filter: LogFilter): string {
  const matchers = Object.entries(filter.labels)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${quote(v as string)}`);
  const selector = `{${matchers.length > 0 ? matchers.join(',') : baseSelector()}}`;

  const stages: string[] = [];
  for (const [k, v] of Object.entries(filter.fields)) {
    if (v) stages.push(`| ${k}=${quote(v)}`);
  }
  for (const term of filter.terms) {
    if (term.kind === 'include') stages.push(`|= ${quote(term.value)}`);
    else if (term.kind === 'exclude') stages.push(`!= ${quote(term.value)}`);
    else stages.push(`|~ ${quote(term.value)}`);
  }
  return [selector, ...stages].join(' ');
}

/** Metric form of the same filter, for the volume histogram. */
export function buildLogVolumeQL(filter: LogFilter, step: string): string {
  return `sum by (level) (count_over_time((${buildLogQL(filter)})[${step}]))`;
}
