// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Display helpers for the plugin health score. The
 * score is computed server-side (api-core `computeHealthScore`); these mirror
 * its component names, labels and display bands without importing server code.
 */

import type { HealthBreakdown } from './types';

export const HEALTH_COMPONENT_ORDER = ['runtime', 'vulns', 'freshness', 'signed', 'smokeTest', 'docs', 'rating'] as const;

export const HEALTH_COMPONENT_LABELS: Record<string, string> = {
  runtime: 'Runtime success (30 days)',
  vulns: 'Known vulnerabilities',
  freshness: 'Freshness',
  signed: 'Signed image',
  smokeTest: 'Smoke test declared',
  docs: 'README and license',
  rating: 'Rating',
};

/** Why a component may be left out (shown instead of a score). */
export const HEALTH_COMPONENT_MISSING: Record<string, string> = {
  runtime: 'Fewer than 20 runs in the last 30 days',
  vulns: 'Not scanned yet',
  freshness: 'No release date recorded',
  rating: 'Fewer than 3 ratings',
};

export type HealthBand = 'good' | 'fair' | 'poor' | 'unknown';

/** good ≥ 80, fair ≥ 50, poor below; unknown when there is no score. */
export function healthBand(score: number | null | undefined): HealthBand {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 80) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}

export const HEALTH_BAND_LABELS: Record<HealthBand, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Not enough data',
};

export interface HealthRow {
  id: string;
  label: string;
  weight: number;
  /** 0..1, or null when left out of the score. */
  score: number | null;
  /** This component's share of the final score (weights renormalized over the known ones), 0..1. */
  share: number | null;
}

/** The breakdown as ordered rows, with each known component's effective share. */
export function healthRows(breakdown: HealthBreakdown | null | undefined): HealthRow[] {
  if (!breakdown) return [];
  const ids = [...HEALTH_COMPONENT_ORDER.filter((id) => breakdown[id]), ...Object.keys(breakdown).filter((k) => !(HEALTH_COMPONENT_ORDER as readonly string[]).includes(k))];
  const known = ids.reduce((a, id) => a + (breakdown[id]?.score === null ? 0 : breakdown[id]?.weight ?? 0), 0);
  return ids.map((id) => {
    const c = breakdown[id]!;
    return {
      id,
      label: HEALTH_COMPONENT_LABELS[id] ?? id,
      weight: c.weight,
      score: c.score,
      share: c.score === null || known === 0 ? null : c.weight / known,
    };
  });
}
