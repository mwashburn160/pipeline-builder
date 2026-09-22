// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin HEALTH SCORE (docs/plugin-publishing.md): one 0–100
 * number per listing, from seven components. Pure and dependency-free so the
 * plugin service (the stats sweep), the frontend (the breakdown panel's
 * labels) and the tests share one definition.
 *
 * Each component scores 0..1 and carries a fixed weight. A component whose
 * inputs are missing is DROPPED and the remaining weights are renormalized; with
 * fewer than {@link HEALTH_MIN_COMPONENTS} components the score is null ("not
 * enough data"), never a guess.
 *
 * | component  | weight | score                                                                 |
 * |------------|--------|-----------------------------------------------------------------------|
 * | runtime    | 25     | 30-day success rate; only with ≥ 20 runs                              |
 * | vulns      | 20     | 1 − 0.5·critical − 0.1·high (floor 0), latest listed version; scanned only |
 * | freshness  | 15     | release age (≤90d 1 → 0 at 540d) averaged with base-image age (≤60d 1 → 0 at 365d) when recorded |
 * | signed     | 10     | image digest present and signed ⇒ 1                                   |
 * | smokeTest  | 10     | smoke test declared ⇒ 1                                               |
 * | docs       | 10     | README 0.5 + license 0.5                                              |
 * | rating     | 10     | Bayesian rating / 5; only with ≥ 3 ratings                            |
 */

export const HEALTH_COMPONENTS = ['runtime', 'vulns', 'freshness', 'signed', 'smokeTest', 'docs', 'rating'] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

/** Nominal weight of each component (they sum to 100). */
export const HEALTH_WEIGHTS: Readonly<Record<HealthComponent, number>> = {
  runtime: 25,
  vulns: 20,
  freshness: 15,
  signed: 10,
  smokeTest: 10,
  docs: 10,
  rating: 10,
};

/** Human labels for the breakdown panel. */
export const HEALTH_COMPONENT_LABELS: Readonly<Record<HealthComponent, string>> = {
  runtime: 'Runtime success (30 days)',
  vulns: 'Known vulnerabilities',
  freshness: 'Freshness',
  signed: 'Signed image',
  smokeTest: 'Smoke test declared',
  docs: 'README and license',
  rating: 'Rating',
};

/** Fewer available components than this ⇒ no score. */
export const HEALTH_MIN_COMPONENTS = 3;
/** Runs needed in the window before the success rate counts. */
export const HEALTH_MIN_RUNS = 20;
/** Ratings needed before the rating counts. */
export const HEALTH_MIN_RATINGS = 3;
/** Release age: full marks up to this many days, zero at {@link HEALTH_RELEASE_ZERO_DAYS}. */
export const HEALTH_RELEASE_FULL_DAYS = 90;
export const HEALTH_RELEASE_ZERO_DAYS = 540;
/** Base-image age: full marks up to this many days, zero at {@link HEALTH_BASE_IMAGE_ZERO_DAYS}. */
export const HEALTH_BASE_IMAGE_FULL_DAYS = 60;
export const HEALTH_BASE_IMAGE_ZERO_DAYS = 365;

/** One component's contribution: its 0..1 score (null = missing, dropped) and its nominal weight. */
export interface HealthComponentScore {
  score: number | null;
  weight: number;
}
export type HealthBreakdown = Record<HealthComponent, HealthComponentScore>;

export interface HealthResult {
  /** 0–100 integer, or null with fewer than {@link HEALTH_MIN_COMPONENTS} components. */
  score: number | null;
  breakdown: HealthBreakdown;
}

/**
 * What the score is computed from. Every field is optional: `undefined` / null
 * means "not known", which drops the component (or, for freshness, that half).
 */
export interface HealthInputs {
  /** Terminal runs in the 30-day window, and the share that succeeded (0..1). */
  runs30d?: number | null;
  successRate30d?: number | null;
  /** The latest listed version's scan; `scannedAt` null ⇒ never scanned. */
  vulnCritical?: number | null;
  vulnHigh?: number | null;
  scannedAt?: Date | string | null;
  /** When the latest listed version was published. */
  lastReleaseAt?: Date | string | null;
  /** The latest listed version's base image `created` time, when recorded. */
  baseImageCreatedAt?: Date | string | null;
  /** Latest listed version has an image digest AND a signature (its `public/*` copy). */
  signed?: boolean | null;
  smokeTestDeclared?: boolean | null;
  hasReadme?: boolean | null;
  hasLicense?: boolean | null;
  ratingBayes?: number | null;
  ratingCount?: number | null;
}

const DAY_MS = 86_400_000;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function toTime(d: Date | string | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 1 up to `fullDays`, falling linearly to 0 at `zeroDays` (a future date counts as fresh). */
export function ageScore(ageDays: number, fullDays: number, zeroDays: number): number {
  if (ageDays <= fullDays) return 1;
  if (ageDays >= zeroDays) return 0;
  return clamp01(1 - (ageDays - fullDays) / (zeroDays - fullDays));
}

/** The vulnerability component: 1 − 0.5·critical − 0.1·high, floored at 0. */
export function vulnScore(critical: number, high: number): number {
  return clamp01(1 - 0.5 * Math.max(0, critical) - 0.1 * Math.max(0, high));
}

function runtimeComponent(i: HealthInputs): number | null {
  if (i.runs30d === null || i.runs30d === undefined || i.runs30d < HEALTH_MIN_RUNS) return null;
  if (i.successRate30d === null || i.successRate30d === undefined || !Number.isFinite(i.successRate30d)) return null;
  return clamp01(i.successRate30d);
}

function vulnsComponent(i: HealthInputs): number | null {
  if (toTime(i.scannedAt) === null) return null;
  return vulnScore(i.vulnCritical ?? 0, i.vulnHigh ?? 0);
}

function freshnessComponent(i: HealthInputs, now: number): number | null {
  const parts: number[] = [];
  const release = toTime(i.lastReleaseAt);
  if (release !== null) parts.push(ageScore((now - release) / DAY_MS, HEALTH_RELEASE_FULL_DAYS, HEALTH_RELEASE_ZERO_DAYS));
  const base = toTime(i.baseImageCreatedAt);
  if (base !== null) parts.push(ageScore((now - base) / DAY_MS, HEALTH_BASE_IMAGE_FULL_DAYS, HEALTH_BASE_IMAGE_ZERO_DAYS));
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

const flag = (b: boolean | null | undefined): number | null => (b === null || b === undefined ? null : b ? 1 : 0);

function docsComponent(i: HealthInputs): number | null {
  if ((i.hasReadme === null || i.hasReadme === undefined) && (i.hasLicense === null || i.hasLicense === undefined)) return null;
  return (i.hasReadme ? 0.5 : 0) + (i.hasLicense ? 0.5 : 0);
}

function ratingComponent(i: HealthInputs): number | null {
  if (i.ratingCount === null || i.ratingCount === undefined || i.ratingCount < HEALTH_MIN_RATINGS) return null;
  if (i.ratingBayes === null || i.ratingBayes === undefined || !Number.isFinite(i.ratingBayes)) return null;
  return clamp01(i.ratingBayes / 5);
}

/** The health score and its per-component breakdown. Pure; `now` is injectable for tests. */
export function computeHealthScore(inputs: HealthInputs, now: Date = new Date()): HealthResult {
  const t = now.getTime();
  const raw: Record<HealthComponent, number | null> = {
    runtime: runtimeComponent(inputs),
    vulns: vulnsComponent(inputs),
    freshness: freshnessComponent(inputs, t),
    signed: flag(inputs.signed),
    smokeTest: flag(inputs.smokeTestDeclared),
    docs: docsComponent(inputs),
    rating: ratingComponent(inputs),
  };
  const breakdown = {} as HealthBreakdown;
  let weighted = 0;
  let totalWeight = 0;
  let available = 0;
  for (const c of HEALTH_COMPONENTS) {
    const score = raw[c];
    breakdown[c] = { score: score === null ? null : round3(score), weight: HEALTH_WEIGHTS[c] };
    if (score === null) continue;
    available++;
    weighted += score * HEALTH_WEIGHTS[c];
    totalWeight += HEALTH_WEIGHTS[c];
  }
  const score = available < HEALTH_MIN_COMPONENTS || totalWeight === 0 ? null : Math.round((100 * weighted) / totalWeight);
  return { score, breakdown };
}

/**
 * A publisher's health: the install-weighted mean of its listings' scores
 * (listings with no score are skipped; when no listing has installs, the plain
 * mean). Null when no listing has a score.
 */
export function publisherHealthScore(listings: ReadonlyArray<{ healthScore: number | null; installCount: number }>): number | null {
  const scored = listings.filter((l): l is { healthScore: number; installCount: number } =>
    l.healthScore !== null && Number.isFinite(l.healthScore));
  if (scored.length === 0) return null;
  const weightOf = (n: number) => Math.max(0, n);
  const totalInstalls = scored.reduce((a, l) => a + weightOf(l.installCount), 0);
  if (totalInstalls === 0) return Math.round(scored.reduce((a, l) => a + l.healthScore, 0) / scored.length);
  return Math.round(scored.reduce((a, l) => a + l.healthScore * weightOf(l.installCount), 0) / totalInstalls);
}

/**
 * A publisher's 30-day success rate across its listings, weighted by runs.
 * Null when none of its listings ran in the window.
 */
export function publisherSuccessRate(listings: ReadonlyArray<{ successRate30d: number | null; runs30d: number }>): number | null {
  let runs = 0;
  let succeeded = 0;
  for (const l of listings) {
    if (l.successRate30d === null || !Number.isFinite(l.successRate30d) || l.runs30d <= 0) continue;
    runs += l.runs30d;
    succeeded += l.successRate30d * l.runs30d;
  }
  return runs === 0 ? null : round3(succeeded / runs);
}

/** Display band for a score: good ≥ 80, fair ≥ 50, poor below, unknown when null. */
export type HealthBand = 'good' | 'fair' | 'poor' | 'unknown';
export const HEALTH_BAND_GOOD = 80;
export const HEALTH_BAND_FAIR = 50;

export function healthBand(score: number | null | undefined): HealthBand {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= HEALTH_BAND_GOOD) return 'good';
  if (score >= HEALTH_BAND_FAIR) return 'fair';
  return 'poor';
}
