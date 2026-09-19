// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One way to ask "is this feature on the viewer's plan, and what do I say if it
 * isn't?".
 *
 * `useFeatures().isEnabled(flag)` answers only the first half, and every caller
 * was re-deriving the second: some added `|| isSuperAdmin` (superadmins hold
 * every entitlement, so a page that forgot it showed an upsell to the operator),
 * some hid the control outright, some wrote their own copy. This returns the
 * whole verdict — entitled, still loading, and the label/description/CTA the
 * lock should render — so the state reads the same everywhere.
 */
import { useFeatures } from './useFeatures';
import { FEATURE_METADATA, type FeatureFlag } from '@/lib/feature-flags';
import { FEATURE_GATES, featureUpsellHref } from '@/lib/feature-gates';

export interface FeatureGateState {
  flag: FeatureFlag;
  /** The viewer may use the feature (holds it, or is a superadmin). */
  entitled: boolean;
  /** `/config` + profile have resolved. Render neither the control nor the lock
   *  before this, or an entitled org sees a flash of "not on your plan". */
  isLoaded: boolean;
  /** Human name, e.g. "Advanced Reporting". */
  label: string;
  /** Catalog description of the entitlement. */
  description: string;
  /** What the entitlement buys, phrased for the lock body. */
  unlocks: string;
  /** Billing deep link that highlights the matching plan/add-on. */
  upsellHref: string;
  /** One-line reason, for a `title=` on a disabled control. */
  reason: string;
}

export function useFeatureGate(flag: FeatureFlag): FeatureGateState {
  const { isEnabled, isLoaded, isSuperAdmin } = useFeatures();
  const meta = FEATURE_METADATA[flag];
  // Superadmins are issued every entitlement in their token, but the bypass is
  // explicit here too — it mirrors `isNavItemVisible`, so the nav link and the
  // surface behind it can't disagree about whether an operator may use it.
  const entitled = isEnabled(flag) || isSuperAdmin;
  return {
    flag,
    entitled,
    isLoaded,
    label: meta.label,
    description: meta.description,
    unlocks: FEATURE_GATES[flag].unlocks,
    upsellHref: featureUpsellHref(flag),
    reason: `${meta.label} isn't included in your current plan`,
  };
}
