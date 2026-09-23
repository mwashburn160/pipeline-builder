// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Field-level diff for an EDIT proposal (`pipeline-edit`, `plugin-edit`,
 * `template-edit`) and for the two remediation kinds. Org settings do not come
 * through here: their fields, shapes and routes are enumerated in the shared
 * allowlist (`@pipeline-builder/api-core/ask-proposals`), which does its own
 * diffing — see `orgSettingsReview` in `proposal.ts`.
 *
 * Why this is not a JSON blob: a blob gets skimmed. A per-field CURRENT ->
 * PROPOSED table makes an unexpected value obvious, and an UNCHANGED field
 * never appears at all, so nothing reads as an edit that isn't one.
 *
 * Two invariants this module exists to hold:
 *
 *  1. **The reviewed diff IS the commit payload.** {@link commitPayload} is
 *     built from the rows the user actually saw, not from the proposal's
 *     `proposed` object — so a field the model slipped in that this module
 *     did not render is structurally unappliable, not merely un-highlighted.
 *     A field that differs but was NOT declared in `changedFields` is counted
 *     in `refused` instead (the injection signal), never applied.
 *  2. **Secrets are never rendered.** An API that answers `hasWebhookSecret`
 *     rather than the secret is saying the value cannot be shown or diffed, so
 *     a field whose NAME reads as a credential (or as a delivery address) is
 *     reduced to set / not set and dropped from the payload.
 */

import type { DiffLine } from '@/lib/line-diff';
import { diffLines } from '@/lib/line-diff';

/** Why a field's value is shown as presence only instead of as a value. */
export type Redaction = 'secret' | 'address';

/**
 * Credential-shaped names: the value is never in a read, and never rendered.
 * `credential` words match anywhere ("webhookSecret", "hasWebhookSecret"); the
 * weaker words only as a SUFFIX, so a field is judged on what it is named after
 * rather than on a substring — `apiKey` and `repoToken` match, `keyPrefix` and
 * `tokenCount` do not.
 */
const SECRET_NAME = /(secret|password|passphrase|credential)|(token|key)$/;
/**
 * Delivery targets: an address or webhook URL in the panel is an egress leak.
 * Suffix-only for the same reason — `externalEmail` and `webhookUrl` are
 * addresses; `emailEnabled` is a boolean that merely mentions one.
 */
const ADDRESS_NAME = /(email|url|address|phonenumber)$/;

/**
 * Whether a field is rendered as presence (`set` / `not set`) rather than as a
 * value — and therefore also excluded from the commit payload. Name-based on
 * purpose: it must refuse a field the panel has never seen before, which a
 * value-shape heuristic cannot do.
 */
export function redactionFor(field: string): Redaction | null {
  const n = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (SECRET_NAME.test(n)) return 'secret';
  if (ADDRESS_NAME.test(n)) return 'address';
  return null;
}

/** Stable JSON: object keys sorted, so key order never reads as a change. */
function canonical(v: unknown): string {
  if (v === undefined) return '\u0000undefined';
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  }) ?? '\u0000undefined';
}

/** Deep value equality by canonical JSON (arrays stay order-sensitive). */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** How a value reads in the table. Redacted fields never reach their value. */
export function describeValue(value: unknown, redaction: Redaction | null): string {
  if (redaction) return value === undefined || value === null || value === '' || value === false ? 'not set' : 'set';
  if (value === undefined) return '—';
  if (value === null) return 'none';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value, null, 2);
}

/** One rendered CURRENT -> PROPOSED row. */
export interface DiffRow {
  /** Stable key — the field name, or the shared allowlist's `<surface>.<field>`. */
  field: string;
  /** Friendlier heading when the key is not itself readable. */
  label?: string;
  from: string;
  to: string;
  /** Non-null when the value is shown as presence only (and not committed). */
  redaction: Redaction | null;
  /** Render as a line diff rather than two inline values. */
  block: boolean;
}

export interface ProposalDiff {
  /** Exactly what the user reviews — and, minus redactions, exactly what is sent. */
  rows: DiffRow[];
  /** Declared changed but identical: dropped, so an unchanged field is never an edit. */
  unchanged: string[];
  /**
   * Dropped from the payload and counted: a field that differs but was not
   * declared in `changedFields` (an undeclared change is the injection signal),
   * or one whose value is redacted and so cannot be applied from here.
   */
  refused: string[];
}

/** A value is long or multi-line enough to want a line diff. */
function isBlock(a: string, b: string): boolean {
  return a.includes('\n') || b.includes('\n') || a.length > 72 || b.length > 72;
}

/**
 * Build the reviewable diff.
 *
 * `changedFields` is an allowlist, not a hint: only a field named there can
 * become a row, and a row is only produced when the two sides actually differ.
 */
export function computeProposalDiff(
  current: Record<string, unknown> | undefined,
  proposed: Record<string, unknown> | undefined,
  changedFields: readonly string[] | undefined,
): ProposalDiff {
  const cur = current ?? {};
  const prop = proposed ?? {};
  const declared = changedFields ?? [];
  const declaredSet = new Set(declared);
  const rows: DiffRow[] = [];
  const unchanged: string[] = [];
  const refused: string[] = [];

  // Anything that differs without being declared never becomes a row.
  for (const field of Object.keys(prop)) {
    if (!declaredSet.has(field) && !sameValue(cur[field], prop[field])) refused.push(field);
  }

  for (const field of declared) {
    if (!Object.prototype.hasOwnProperty.call(prop, field)) { unchanged.push(field); continue; }
    if (sameValue(cur[field], prop[field])) { unchanged.push(field); continue; }
    const redaction = redactionFor(field);
    const from = describeValue(cur[field], redaction);
    const to = describeValue(prop[field], redaction);
    // A redacted field is shown (so the user sees it was touched) but is not
    // appliable from here — it is counted with the rest of the refusals.
    if (redaction) refused.push(field);
    rows.push({ field, from, to, redaction, block: !redaction && isBlock(from, to) });
  }

  return { rows, unchanged, refused };
}

/**
 * The commit body: the reviewed rows, and nothing else. Built from `rows`
 * rather than from `proposed`, so an undeclared or redacted field cannot ride
 * along — the payload is a projection of what was on screen.
 */
export function commitPayload(proposed: Record<string, unknown> | undefined, rows: readonly DiffRow[]): Record<string, unknown> {
  const prop = proposed ?? {};
  const out: Record<string, unknown> = {};
  for (const r of rows) if (!r.redaction) out[r.field] = prop[r.field];
  return out;
}

/**
 * Re-read check. These tables carry no version column, so the only way to know
 * the approved diff is still the applied diff is to compare the freshly-read
 * entity against the snapshot the diff was rendered from.
 *
 * Only the REVIEWED fields are compared: an unrelated column moving (or a
 * volatile one like `updatedAt`) does not invalidate a diff that does not touch
 * it, and comparing everything would make the refusal fire constantly and get
 * ignored.
 */
export function staleFields(
  draftCurrent: Record<string, unknown> | undefined,
  fresh: Record<string, unknown> | undefined,
  rows: readonly DiffRow[],
): string[] {
  const snap = draftCurrent ?? {};
  const now = fresh ?? {};
  return rows.map((r) => r.field).filter((f) => !sameValue(snap[f], now[f]));
}

/** Line-diff for a `block` row (re-exported so the view has one import). */
export function rowLines(row: DiffRow): DiffLine[] {
  return diffLines(row.from, row.to);
}
