// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quota-type display catalog, as DATA ONLY — what a quota is CALLED and how
 * its number is RENDERED, for every `QuotaType`.
 *
 * Dependency-free and env-free so the browser imports it directly
 * (`@pipeline-builder/api-core/quota-catalog`). Its only import is a type, which
 * is erased at compile time, so nothing of the server graph reaches the bundle.
 *
 * WHY IT EXISTS. The same facts were spelled in six places: this package's
 * `QUOTA_TYPE_LABELS`, and five independent maps in the frontend — the pressure
 * banner's labels, the quotas page's `QUOTA_META`, the org home's `QUOTA_LABELS`,
 * the billing usage card's `QUOTA_LABELS` (with its own byte flag), and the
 * add-on grid's `PACK_UNITS`. Each knew a subset, each could drift, and adding a
 * quota type meant finding all six. `PACK_UNITS` had exactly one member, so the
 * add-on grid rendered a GB step for storage and a bare pack count for
 * everything else — not a decision anyone revisited, just the one entry somebody
 * needed at the time.
 *
 * Add a quota type here and every surface renders it: `Record<QuotaType, …>`
 * makes the compiler demand the entry, so none of the six can be forgotten
 * again.
 *
 * EVERY display fact lives here, including the plural label. A first draft kept
 * plurals in a frontend helper with a `Record<string, string>` and a fallback to
 * the singular — which would have rendered a new quota type's plural wrongly and
 * silently, reproducing the exact partial-map trap this file removes. A fact
 * split across two packages is a fact that drifts.
 */

import type { QuotaType } from './common.js';

/** How a quota's usage is learned: incremented as it happens, or read on demand. */
export type QuotaObservation =
  /** The platform increments a counter as the work happens. */
  | 'metered'
  /** Nothing increments: the figure is read from the system of record. */
  | 'measured';

/** Whether a quota refills on the period or persists until something changes. */
export type QuotaAccrual =
  /** A per-period rate: reserved on use, zeroed at the period boundary. */
  | 'flow'
  /** A level that stays until the tenant frees it. No reset, no forecast. */
  | 'stock';

/** How a raw quota number should be rendered. */
export type QuotaRender =
  /** A plain integer — "4 / 10". */
  | 'count'
  /** A byte count — render with `formatBytes` ("18.4 GB"), never raw. */
  | 'bytes';

/** What a surface needs to know to show one quota type. */
export interface QuotaTypeMeta {
  /**
   * SINGULAR human label — the one spelling every 429 body, notification and
   * dashboard uses ("API call quota reached …").
   */
  label: string;
  /**
   * PLURAL label, for surfaces that list dimensions rather than address one
   * ("API calls" on a usage card, against "API call quota reached" in a 429).
   *
   * REQUIRED, and here rather than in the frontend, because the first draft put
   * it in a `Record<string, string>` helper that fell back to the singular when
   * a type was missing — so a new quota type would have rendered "Build minute"
   * in plural contexts, wrongly and silently. That is the same partial-map trap
   * this catalog exists to remove, and `Record<QuotaType, …>` closes it only if
   * every display fact lives here.
   */
  labelPlural: string;
  /** How to render a raw value for this type. */
  render: QuotaRender;
  /**
   * Whether this quota REFILLS on the period, or persists until the tenant
   * changes something.
   *
   * This is the single most load-bearing semantic difference between quota
   * types and nothing could read it before: a surface had to know, by hand,
   * that "resets in 2 days" is true of `apiCalls` and false of `storageBytes`.
   * Getting it wrong is not cosmetic — the quotas page told an organization its
   * registry storage would reset, which is the opposite of the one thing it
   * needs to understand about storage.
   *
   * - `flow` — a per-period rate, reserved on create/build and zeroed at the
   *   boundary. Hitting it is temporary and the account self-heals. The period is
   *   PER TYPE rather than global: `QUOTA_RESET_DAYS` (3 days) for every flow but
   *   `cpuCredits`, which is monthly. Read it through `quotaPeriodDays` and never
   *   assume the global — a forecast or a "resets in N days" line computed
   *   against the wrong window is wrong by a factor of ten for credits.
   * - `stock` — a level, not a rate. It stays where it is until bytes are freed
   *   or rows are deleted, so a reset date, a "resets in N days" line and a
   *   burn-rate forecast are all meaningless for it. `storageBytes` is measured;
   *   the resource-count caps are counted at create time and decremented on
   *   delete; `listings` counts active publications.
   *
   * The {@link QuotaTypeMeta.description} wording follows from this ("this
   * period" against "currently"), and a test holds the two in agreement.
   */
  accrual: QuotaAccrual;
  /**
   * How usage is OBSERVED — which is a different question from whether the
   * quota refills, and the two do not line up.
   *
   * - `metered` — the platform INCREMENTS a counter as the work happens. Every
   *   quota but one, including the create-time counts that are stocks
   *   (`dashboards`, `listings`, …).
   * - `measured` — nothing increments anything; the figure is READ from the
   *   system of record on demand. `storageBytes` only: the registry walks its
   *   own catalog, which is why it is "the one quota nothing increments".
   *
   * It decides which code path may legitimately notify about a quota. A storage
   * notice arriving from the increment path could only be a bug, and a
   * `listings` notice arriving from a sweep likewise — conflating this with
   * {@link accrual} would have silenced every create-time count quota, because
   * those are stocks that are nonetheless metered.
   */
  observed: QuotaObservation;
  /**
   * What this counter actually counts, in one short phrase — the answer to "am I
   * spending this one?".
   *
   * REQUIRED, and a display FACT rather than page copy, which is the call a
   * first pass got wrong by judging the field's name instead of its content. It
   * had been left in a frontend `Record<DisplayedQuotaType, string>` on the
   * reasoning that descriptions are a page's own voice. They are not: each of
   * these answers a question whose answer is the same on every surface, and two
   * surfaces disagreeing is a bug, not a difference in tone. Two of the five
   * local copies had already drifted — `automationCalls` omitted personal
   * access keys (so a PAT holder read the page and concluded they were spending
   * `apiCalls`), and `plugins`/`pipelines` were phrased as stocks.
   *
   * The test is whether `docs/quotas.md` and this string can legitimately
   * differ. For these, no. For a tier's positioning line ("Starter tier") or the
   * quotas page's pooling explanation, yes — those stay in the page, exactly as
   * `TIER_META` already splits a tier's label from its sales copy.
   *
   * Phrasing follows the SEMANTICS in {@link QuotaType}'s own documentation, not
   * a house style: "this period" for the per-period flows, "currently" for the
   * create-time counts that decrement on delete, and neither for the measured
   * storage total.
   */
  description: string;
  /**
   * The unit an ADD-ON PACK of this quota is typed in, and the divisor from the
   * raw grant to that unit — so a +10 GB storage pack offers a GB step rather
   * than a pack count.
   *
   * Absent means "type pack counts", which is right where the quota has no
   * natural unit: "1 pack of API calls" reads better than "25000 calls". The
   * step itself is always derived from the bundle's own `grants`, never from a
   * constant here, because a grant is env-overridable.
   */
  packUnit?: { name: string; per: number };
}

const GB = 1024 ** 3;

/**
 * Display metadata for every quota type. Labels are the canonical ones — the
 * strings here are user-facing and are relied on by 429 bodies and notices, so
 * they change only deliberately.
 */
export const QUOTA_CATALOG: Readonly<Record<QuotaType, QuotaTypeMeta>> = {
  // Per-period FLOWS — a creation rate, not a stock. Deleting the entity does
  // not give the slot back (`decrement-on-delete` was considered and rejected),
  // so the wording says "this period" to stop the stock reading.
  plugins: { label: 'Plugin build', labelPlural: 'Plugins', render: 'count', accrual: 'flow', observed: 'metered', description: 'Plugin versions deployed this period' },
  pipelines: { label: 'Pipeline creation', labelPlural: 'Pipelines', render: 'count', accrual: 'flow', observed: 'metered', description: 'Pipelines created this period' },
  // The call budgets. WHICH ONE a request spends is decided by
  // `meteredQuotaTypeFor`, never by the route: a service-account key, a PERSONAL
  // ACCESS key (`token_use: 'api_key'`) or anything minted while holding one
  // (`parentKeyId`) spends `automationCalls` INSTEAD of `apiCalls`.
  apiCalls: { label: 'API call', labelPlural: 'API calls', render: 'count', accrual: 'flow', observed: 'metered', description: 'Requests made by people in browser sessions this period' },
  automationCalls: { label: 'Automation call', labelPlural: 'Automation calls', render: 'count', accrual: 'flow', observed: 'metered', description: 'Requests made with service-account or personal access keys this period' },
  aiCalls: { label: 'AI call', labelPlural: 'AI calls', render: 'count', accrual: 'flow', observed: 'metered', description: 'AI generation invocations this period' },
  // The one flow quota on a period of its OWN — a MONTH, where every other flow
  // rolls on QUOTA_RESET_DAYS (3 days). Rendered as a COUNT and never as a
  // duration: the unit is an abstract credit precisely so it cannot be misread as
  // wall-clock ("11,250 build minutes" reads as 187 hours when it buys 125), and
  // formatting it back into "187h 30m" would undo that. The wall-clock conversion
  // belongs in the pre-build cost hint, where it explains rather than misleads.
  cpuCredits: { label: 'CPU credit', labelPlural: 'CPU credits', render: 'count', accrual: 'flow', observed: 'metered', description: 'vCPU-minutes of build compute used this month', packUnit: { name: 'credits', per: 1 } },
  // A MEASURED total, recomputed on demand rather than counted — the one quota
  // that is neither a period flow nor a create-time count.
  storageBytes: { label: 'Registry storage', labelPlural: 'Registry storage', render: 'bytes', accrual: 'stock', observed: 'measured', description: 'Registry storage currently in use', packUnit: { name: 'GB', per: GB } },
  // Resource-count caps: counted at create time and DECREMENTED on delete, so
  // these really are stocks and "this period" would be wrong.
  dashboards: { label: 'Dashboard', labelPlural: 'Dashboards', render: 'count', accrual: 'stock', observed: 'metered', description: 'Dashboards currently defined' },
  alertRules: { label: 'Alert rule', labelPlural: 'Alert rules', render: 'count', accrual: 'stock', observed: 'metered', description: 'Alert rules currently defined' },
  alertDestinations: { label: 'Alert destination', labelPlural: 'Alert destinations', render: 'count', accrual: 'stock', observed: 'metered', description: 'Alert destinations currently defined' },
  idpConfigs: { label: 'IdP configuration', labelPlural: 'IdP configurations', render: 'count', accrual: 'stock', observed: 'metered', description: 'Identity-provider configurations currently defined' },
  listings: { label: 'Plugin listing', labelPlural: 'Plugin listings', render: 'count', accrual: 'stock', observed: 'metered', description: 'Active plugin listings you publish' },
};

/**
 * Consumables that are NOT quota types but render beside them — same label,
 * same bar, same card.
 *
 * `seats` is the only one: it is a STOCK (how many people may be on the
 * account) rather than a per-period flow, so it is deliberately outside
 * `QuotaType` and is sourced separately from the quota rollup. But the billing
 * usage card draws it in the same list, and before this entry existed that one
 * row carried its own inline "Seats" label while the five beside it came from
 * the catalog — the precise split-fact drift this file exists to remove.
 *
 * Keep this for things rendered AS a consumable. It is not a back door for
 * quota types: a real quota belongs in {@link QUOTA_CATALOG}, where
 * `Record<QuotaType, …>` forces the entry.
 */
export const NON_QUOTA_CONSUMABLE_CATALOG: Readonly<Record<string, QuotaTypeMeta>> = {
  seats: { label: 'Seat', labelPlural: 'Seats', render: 'count', accrual: 'stock', observed: 'measured', description: 'Members this account may have' },
};

/**
 * Every described consumable, widened for lookups by a value that came off the
 * wire.
 */
const byKey: Record<string, QuotaTypeMeta | undefined> = {
  ...NON_QUOTA_CONSUMABLE_CATALOG,
  ...QUOTA_CATALOG,
};

/**
 * This type's singular label, or the raw key for a value outside the catalog.
 *
 * The accessors take `string` because the quota type often arrives from the wire
 * (a 429 body, a quota response) where an unknown value must render as something
 * rather than crash a page. The `QuotaType` overload is for internal callers: it
 * makes a typo a compile error instead of a key rendered as a label.
 */
export function quotaLabel(type: QuotaType): string;
export function quotaLabel(type: string): string;
export function quotaLabel(type: string): string {
  return byKey[type]?.label ?? type;
}

/** This type's PLURAL label, or the raw key for a value outside the catalog. */
export function quotaLabelPlural(type: QuotaType): string;
export function quotaLabelPlural(type: string): string;
export function quotaLabelPlural(type: string): string {
  return byKey[type]?.labelPlural ?? type;
}

/**
 * How to render this type's values. `count` for anything the catalog does not
 * know, so an unfamiliar wire value renders as a plain number.
 *
 * Read THIS rather than asking "is it bytes?". A boolean helper degrades
 * silently the moment {@link QuotaRender} grows a third member — a new mode
 * would simply render as a count, with nothing failing — whereas a caller that
 * switches on this value exhaustively stops compiling until it handles the new
 * mode. That is the whole point of the catalog, applied to its own accessors.
 */
export function quotaRender(type: QuotaType): QuotaRender;
export function quotaRender(type: string): QuotaRender;
export function quotaRender(type: string): QuotaRender {
  return byKey[type]?.render ?? 'count';
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as a human amount — `1.5 GB`, `512 MB`, `0 B`.
 *
 * The ONE implementation: the frontend's `formatBytes` delegates here rather
 * than keeping its own copy, so a storage figure reads identically in a quota
 * notice, a 403 explanation and the dashboard. Binary units (1024), one decimal
 * below 10 and rounded above, which is what the dashboard already rendered —
 * this moved the algorithm, it did not change it.
 */
export function formatByteAmount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return value < 10 ? `${value.toFixed(1)} ${BYTE_UNITS[i]}` : `${Math.round(value)} ${BYTE_UNITS[i]}`;
}

/**
 * A raw quota value as the amount a HUMAN should read, per this type's
 * {@link QuotaRender} — bytes as `25 GB`, counts grouped as `60,000`.
 *
 * For server-side copy (quota notices, audit reasons, 403 explanations), which
 * is why it is here rather than in the frontend: a storage notice that
 * interpolated the raw number would read "used all 26843545600 of its registry
 * storage". The frontend has its own thin wrapper because it renders an
 * unlimited (-1) limit as `∞`, which is a display choice no server copy makes
 * (unlimited orgs are skipped before any copy is generated).
 */
export function formatQuotaAmount(type: string, value: number): string {
  return quotaRender(type) === 'bytes' ? formatByteAmount(value) : value.toLocaleString('en-US');
}

/**
 * How this quota's usage is observed: `metered` (incremented) or `measured`
 * (read on demand). Unknown wire values read as `metered`, matching every
 * quota but storage.
 */
export function quotaObservation(type: QuotaType): QuotaObservation;
export function quotaObservation(type: string): QuotaObservation;
export function quotaObservation(type: string): QuotaObservation {
  return byKey[type]?.observed ?? 'metered';
}

/**
 * Whether this quota refills on the period (`flow`) or persists (`stock`).
 * Unknown wire values are treated as `flow`, matching every metered quota.
 */
export function quotaAccrual(type: QuotaType): QuotaAccrual;
export function quotaAccrual(type: string): QuotaAccrual;
export function quotaAccrual(type: string): QuotaAccrual {
  return byKey[type]?.accrual ?? 'flow';
}

/** What this type counts, or the empty string for a value outside the catalog. */
export function quotaDescription(type: QuotaType): string;
export function quotaDescription(type: string): string;
export function quotaDescription(type: string): string {
  return byKey[type]?.description ?? '';
}

/** The pack unit for this type, or `null` to type pack counts instead. */
export function quotaPackUnit(type: QuotaType): { name: string; per: number } | null;
export function quotaPackUnit(type: string): { name: string; per: number } | null;
export function quotaPackUnit(type: string): { name: string; per: number } | null {
  return byKey[type]?.packUnit ?? null;
}
