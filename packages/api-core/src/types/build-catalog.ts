// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a build's CLASS and SIZE are called, what they cost, and which tier may
 * ask for them (D11/D13).
 *
 * ONE module instead of six tables. The facts used to live in
 * `wire-vocabulary.ts` (the two id lists and the size multipliers),
 * `quota-tiers.ts` (which tier gets which size, and the per-class slot counts)
 * and a hand-maintained mirror of all four in `frontend/src/lib/build-shape.ts`
 * — held together by a test that parsed this package's TypeScript SOURCE with
 * regexes to detect drift. This is the same move `quota-catalog.ts` made for the
 * five frontend label maps, and for the same reason: the browser imports the
 * catalog directly, so there is nothing left to drift.
 *
 * DEPENDENCY-FREE, and that is a constraint rather than a happy accident. Only
 * type-only imports, which are erased, so this module loads in a browser; the
 * moment it reads an env var it stops being importable by the frontend and the
 * mirror comes back. Everything here is therefore a DEFAULT. The env overlay
 * (`PLUGIN_MAX_BUILDS_<TIER>_<CLASS>`, `PLUGIN_BUILDKIT_ADDR_SIZE_<SUFFIX>`)
 * lives server-side, which is the same split the tier presets already use: a
 * hardcoded fallback plus a `/config` overlay.
 *
 * IDS ARE ARITHMETIC, LABELS ARE WORDS. `0.5x` carries its own multiplier, so
 * `buildSizeMultiplier` is checkable by eye and the credit math is
 * self-documenting; `Small` / `Standard` / `Medium` / `Large` / `X-Large` is what
 * a person reads. Keeping them separate is also what makes a rename cheap: a
 * label is one line here, with no wire value, Redis key, metric label or ledger
 * string to migrate.
 */

import type { QuotaTier } from './quota-tiers.js';

// ---------------------------------------------------------------------------
// Scheduling class — WHEN a build starts
// ---------------------------------------------------------------------------

/**
 * `flexible` rather than `batch`, `deferred` or `small`.
 *
 * It names what the CUSTOMER trades — a flexible start time — instead of what
 * the platform does with it, and it does not read as a demotion: this class is
 * available on every tier including free, and `deferred` sounds broken while
 * `low priority` sounds like a penalty. `small` was rejected outright because it
 * is a magnitude word on a latency dimension — `{ buildClass: 'small',
 * buildSize: '2x' }` is legal and unreadable.
 */
export const BUILD_CLASSES = ['standard', 'flexible'] as const;
export type BuildClass = (typeof BUILD_CLASSES)[number];

export interface BuildClassMeta {
  /** What a person reads. */
  label: string;
  /** The trade, said in one line beside the control. */
  blurb: string;
  /**
   * In-flight builds one ORG may hold in this class, per tier — the DEFAULT for
   * `PLUGIN_MAX_BUILDS_<TIER>_<CLASS>`.
   *
   * Graded by tier rather than one flat figure: a single figure gave a Developer
   * org the same three in-flight builds as an Enterprise one, which made the
   * per-org semaphore the one place in the build path that ignored what the
   * tenant pays for. `flexible` has more headroom than `standard` on every row,
   * because the cheap class is where the room has to be for it to smooth
   * anything — a row where they were equal would make the class pointless to
   * choose.
   */
  slotsByTier: Readonly<Record<QuotaTier, number>>;
}

export const BUILD_CLASS_CATALOG: Readonly<Record<BuildClass, BuildClassMeta>> = {
  standard: {
    label: 'Standard',
    blurb: 'Starts as soon as a slot is free. Use it for anything you are waiting on.',
    slotsByTier: {
      developer: 1,
      pro: 2,
      team: 3,
      business: 5,
      enterprise: 8,
      // Billing disabled: nothing is capped, so the ceiling is the pool itself.
      unlimited: 8,
    },
  },
  flexible: {
    label: 'Flexible',
    blurb: 'Starts later, in exchange for more builds at once. Same cost per build.',
    slotsByTier: {
      developer: 3,
      pro: 4,
      team: 6,
      business: 10,
      enterprise: 16,
      unlimited: 16,
    },
  },
};

// ---------------------------------------------------------------------------
// Machine size — HOW MUCH CPU a build gets
// ---------------------------------------------------------------------------

export const BUILD_SIZES = ['0.5x', '1x', '2x', '4x', '8x'] as const;
export type BuildSize = (typeof BUILD_SIZES)[number];

export interface BuildSizeMeta {
  /** What a person reads: Small … X-Large. */
  label: string;
  /** vCPU relative to the deployment's base figure, and the credit rate. */
  multiplier: number;
  /**
   * Lowest tier that may REQUEST this size; `null` means every tier may.
   *
   * One field per size rather than a row per tier, and that makes the ladder's
   * monotonicity STRUCTURAL: a row-per-tier table can express "Team has 4x but
   * Business does not" and needed a test to forbid it. This shape cannot.
   */
  minTier: QuotaTier | null;
  /**
   * The class this size pairs with unless the caller says otherwise.
   *
   * Why `0.5x` defaults to `flexible`: a half-speed build takes roughly twice as
   * long and therefore HOLDS ITS SLOT twice as long. On Developer — one standard
   * slot — one cheap build would block the only urgent-fix slot for double the
   * time. Defaulting it to the class with three slots means it cannot.
   */
  defaultClass: BuildClass;
  /**
   * Suffix of this size's buildkitd pool override
   * (`PLUGIN_BUILDKIT_ADDR_SIZE_<SUFFIX>`).
   *
   * Declared rather than derived from the id, because deriving it produces
   * ILLEGAL NAMES: `'0.5x'.toUpperCase()` gives `0.5X` and a dot cannot appear in
   * an environment variable name (the same reason `x-large` was rejected as an
   * id — `..._X-LARGE` is not an identifier either).
   */
  envSuffix: string;
}

/**
 * The size ladder.
 *
 * A size is a BIGGER DAEMON, not a flag: `buildctl` has no per-build CPU option,
 * because the CPU a build may use is the buildkitd POD's limit. So every rung
 * above or below `1x` needs a pool of its own, and a rung with no pool is
 * REFUSED rather than silently served at `1x` — in both directions. Serving
 * `4x` from the shared daemon would charge four times for one times the speed;
 * serving `0.5x` from it would hand every tenant full speed at half price.
 */
export const BUILD_SIZE_CATALOG: Readonly<Record<BuildSize, BuildSizeMeta>> = {
  // Available to EVERY tier, deliberately. It is a budget option, not a
  // restriction: the free tier gains a real choice (spend less) instead of a
  // list of locks. The arithmetic is honest in one direction — a CPU-bound build
  // takes twice as long at half the vCPU and costs the SAME, while an I/O-bound
  // one costs about half. So Small can never cost more than Standard, and can
  // cost half (assuming slowdown is at most linear, which memory pressure can
  // break).
  '0.5x': { label: 'Small', multiplier: 0.5, minTier: null, defaultClass: 'flexible', envSuffix: 'HALF' },
  '1x': { label: 'Standard', multiplier: 1, minTier: null, defaultClass: 'standard', envSuffix: '1X' },
  '2x': { label: 'Medium', multiplier: 2, minTier: 'team', defaultClass: 'standard', envSuffix: '2X' },
  '4x': { label: 'Large', multiplier: 4, minTier: 'business', defaultClass: 'standard', envSuffix: '4X' },
  '8x': { label: 'X-Large', multiplier: 8, minTier: 'enterprise', defaultClass: 'standard', envSuffix: '8X' },
};

/**
 * The tier ladder, ascending, for evaluating {@link BuildSizeMeta.minTier}.
 *
 * Declared here because a dependency-free module cannot import `VALID_TIERS` (it
 * is derived from the env-reading tier table). `unlimited` sits at the top so
 * the no-billing install gates nothing — a gate there would invent a limit the
 * operator never bought into. Pinned against the `QuotaTier` union by a test.
 */
export const BUILD_TIER_LADDER: readonly QuotaTier[] = [
  'developer', 'pro', 'team', 'business', 'enterprise', 'unlimited',
];

/**
 * How many of a tier's builds run AT ONCE, across every org on that tier
 * (`PLUGIN_BUILD_CONCURRENCY_<TIER>` overrides each row).
 *
 * TIER-keyed, not class-keyed, and that is the queue topology rather than a
 * simplification: there is one BullMQ `Worker` per tier queue and both
 * scheduling classes are served by it, so a per-class figure here could not be
 * honoured — it would either duplicate this number or invite someone to set a
 * value the worker cannot act on.
 *
 * **A ladder, not one figure.** This is the AGGREGATE bound that makes a tier's
 * advertised per-build capacity deliverable: the cap is reachable by a single
 * tenant, and the number of tenants reaching for it concurrently is limited
 * here, where it can be tuned without touching the price list.
 *
 * It lived as a bare literal map inside the build worker until now, which is
 * exactly how `docs/environment-variables.md` came to describe a global default
 * that the code had stopped honouring — a figure no catalog exposes is a figure
 * the documentation drifts away from. It sits beside `slotsByTier` and
 * `minTier` because it is the third tier-keyed build figure, not a different
 * kind of thing.
 *
 * **Distinct from the per-org slot cap, and the LOWER of the two binds.** This
 * is pod capacity (every concurrent build drives the same buildkitd); the slot
 * cap is fairness between tenants sharing this queue. A tier whose concurrency
 * sits below its slot cap cannot reach that cap at all, which is why the worker
 * warns about it on start.
 *
 * Monotonic across the PAID rungs only. `unlimited` sits at the bottom, not the
 * top: it is not a purchased tier but the absence of billing, which correlates
 * with the smallest hardware — see its own note below.
 */
export const BUILD_TIER_CONCURRENCY: Readonly<Record<QuotaTier, number>> = {
  developer: 1,
  pro: 2,
  team: 2,
  business: 3,
  enterprise: 4,
  /**
   * ONE, and the lowest row — deliberately NOT the most generous.
   *
   * `unlimited` means "billing is not configured", which in practice is a
   * single-node install (local, minikube, a fresh cluster), and it is also the
   * SYSTEM ORG's tier — the org that loads the whole sample catalogue on first
   * boot. Giving it 4 handed the highest concurrency to the tier most likely to
   * be running on the smallest hardware.
   *
   * It cost an install: 8 plugin replicas x 4 = 32 concurrent builds, each
   * asking the image registry to sign a 7-17 MiB SBOM against its 1 GiB limit.
   * The registry was OOMKilled, and because its `/token` endpoint is also the
   * registry login, the pushes failed too — 107 of 117 plugins never came up.
   * The earlier default of 1 (then a global knob) had produced 95 of 119.
   *
   * Raise it per deployment with `PLUGIN_BUILD_CONCURRENCY_UNLIMITED` once the
   * registry's memory and a signing bound say the fan-in is safe.
   */
  unlimited: 1,
};

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * What ONE replica may run at once if every tier queue is busy: the SUM of the
 * ladder, because a replica starts one BullMQ Worker per tier and each carries
 * its own concurrency.
 *
 * This number was never written down, and that is the point of writing it down.
 * The incident arithmetic everyone reasoned with — "8 replicas x 4 = 32" — is
 * the single-tier case (a catalogue load is all system-org). A mixed fleet
 * reaches `replicas x this`, which is 13 per replica and 104 across the eight a
 * plugin deployment scales to. The ladder's rows therefore set a fleet ceiling
 * that nothing declared and nobody chose.
 *
 * `PLUGIN_MAX_BUILDS_PER_REPLICA` defaults to this, so raising a tier row cannot
 * silently raise what one replica puts on its single buildkitd sidecar — it
 * binds at this figure and the worker says so on start.
 */
export const BUILD_LADDER_CONCURRENCY_SUM: number =
  BUILD_TIER_LADDER.reduce((n, tier) => n + BUILD_TIER_CONCURRENCY[tier], 0);

/**
 * This tier's default worker concurrency. Falls back to the `developer` row for
 * an unrecognised tier, matching `buildSlotsFor` — a bad tier string must not
 * hand out the most generous figure in the table.
 */
export function buildWorkerConcurrencyFor(tier: QuotaTier): number {
  return BUILD_TIER_CONCURRENCY[tier] ?? BUILD_TIER_CONCURRENCY.developer;
}

/**
 * The env var that overrides {@link buildWorkerConcurrencyFor} for one tier.
 *
 * Derived rather than written out six times: the per-tier reads used to be six
 * near-identical `envInt` lines, where a wrong cross-reference
 * (`pro: envInt('…_PRO', tierDefault.team)`) silently takes another tier's
 * default and no type can catch it.
 */
export function buildConcurrencyEnvVar(tier: QuotaTier): string {
  return `PLUGIN_BUILD_CONCURRENCY_${tier.toUpperCase()}`;
}

/** This size's credit/vCPU multiplier; `1` for anything unrecognised. */
export function buildSizeMultiplier(size: string): number {
  return BUILD_SIZE_CATALOG[size as BuildSize]?.multiplier ?? 1;
}

/** `Small` … `X-Large`; the raw id for anything unrecognised. */
export function buildSizeLabel(size: string): string {
  return BUILD_SIZE_CATALOG[size as BuildSize]?.label ?? size;
}

/** `Standard` / `Flexible`; the raw id for anything unrecognised. */
export function buildClassLabel(buildClass: string): string {
  return BUILD_CLASS_CATALOG[buildClass as BuildClass]?.label ?? buildClass;
}

/**
 * Env-var suffix of this size's buildkitd pool override.
 *
 * Declared in the catalog rather than derived, because deriving it produces
 * ILLEGAL NAMES: `'0.5x'.toUpperCase()` is `0.5X`, and a dot cannot appear in an
 * environment variable name. (It is the same reason `x-large` was rejected as an
 * id — `..._X-LARGE` is not an identifier either.) Falls back to `1X`, the
 * shared daemon, for an unrecognised size.
 */
export function buildSizeEnvSuffix(size: string): string {
  return BUILD_SIZE_CATALOG[size as BuildSize]?.envSuffix ?? '1X';
}

/** The class this size runs in unless the caller overrides it. */
export function defaultClassForSize(size: string): BuildClass {
  return BUILD_SIZE_CATALOG[size as BuildSize]?.defaultClass ?? 'standard';
}

/**
 * How much longer a build at this size may run before the timeout kills it.
 *
 * Scales UP below `1x` and never down above it, and the asymmetry is the point:
 * the timeout is a SAFETY bound on a runaway build, not a budget. At half the
 * vCPU a ten-minute build becomes about twenty and would die on a 15-minute
 * bound — so Small would quietly fail long builds (as a `retryable` failure, so
 * the tenant is not charged, but it is retried twice and dead-lettered). Scaling
 * it DOWN at `4x` would instead break I/O-bound builds that gain nothing from
 * the extra CPU.
 */
export function buildTimeoutFactor(size: string): number {
  return Math.max(1, 1 / buildSizeMultiplier(size));
}

/** In-flight builds one org on `tier` may hold in `buildClass` (the default). */
export function buildSlotsFor(tier: QuotaTier, buildClass: BuildClass): number {
  const meta = BUILD_CLASS_CATALOG[buildClass] ?? BUILD_CLASS_CATALOG.standard;
  return meta.slotsByTier[tier] ?? meta.slotsByTier.developer;
}

/** Both classes' slot counts for one tier — the per-tier reading the UI wants. */
export function buildSlotsByClass(tier: QuotaTier): Readonly<Record<BuildClass, number>> {
  return {
    standard: buildSlotsFor(tier, 'standard'),
    flexible: buildSlotsFor(tier, 'flexible'),
  };
}

/** Whether `tier` may request `size`. */
export function tierAllowsBuildSize(tier: QuotaTier, size: string): boolean {
  const meta = BUILD_SIZE_CATALOG[size as BuildSize];
  if (!meta) return false;
  if (meta.minTier === null) return true;
  const have = BUILD_TIER_LADDER.indexOf(tier);
  // An unrecognised tier gets the FLOOR of the ladder — the smallest allowance,
  // never everything. Same conservative call `tierForQueueName` makes.
  if (have < 0) return false;
  return have >= BUILD_TIER_LADDER.indexOf(meta.minTier);
}

/** Every size `tier` may request, ascending. */
export function buildSizesForTier(tier: QuotaTier): readonly BuildSize[] {
  return BUILD_SIZES.filter((s) => tierAllowsBuildSize(tier, s));
}
