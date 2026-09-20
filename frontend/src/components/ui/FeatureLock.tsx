// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Callout } from './Callout';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import type { FeatureFlag } from '@/lib/feature-flags';

/**
 * The single "this isn't on your plan" state for an entitlement-gated control.
 *
 * Rendered IN PLACE of (or beside) the control the API would 403, so the answer
 * arrives before the click instead of as a bare error afterwards. It always says
 * three things: which entitlement is missing, what that entitlement buys, and
 * where to get it — "don't just hide it" is the point; a hidden control leaves a
 * paying customer wondering whether the product can do the thing at all.
 *
 * "Where to get it" is not the same sentence for every flag. An add-on gets a
 * deep link to its card on the billing page; a feature that only comes with a
 * plan (`acquiredVia: 'tier'`, e.g. `sso` from Team up) gets the Plans tab and
 * is TOLD which plan it starts at — pointing `?highlight=` at a bundle that
 * isn't in the catalog just lands the viewer on an unhighlighted add-on grid.
 *
 * Renders nothing until `/config` + the profile have resolved, so an entitled
 * org never sees a flash of the lock.
 */
export function FeatureLock({ flag, className = '' }: { flag: FeatureFlag; className?: string }) {
  const gate = useFeatureGate(flag);
  if (!gate.isLoaded || gate.entitled) return null;
  return (
    <Callout
      variant="warning"
      icon={Lock}
      title={gate.reason}
      className={className}
    >
      <span data-testid={`feature-lock-${flag}`}>
        {gate.label} unlocks {gate.unlocks}.{' '}
        {/* Said BEFORE the CTA, and said even to a viewer who can't open
            billing: "it comes with Team" is the actionable half, and the link
            is only how you get there. */}
        {gate.includedFromPlan && (
          <>It&apos;s included from the <strong>{gate.includedFromPlan}</strong> plan and isn&apos;t sold separately.{' '}</>
        )}
        {gate.canUpsell ? (
          <>
            <Link href={gate.upsellHref} className="font-medium underline underline-offset-2">
              {gate.upsellCta}
            </Link>
            {gate.upsellTrailer}
          </>
        ) : (
          // No `billing:read` (or billing is off in this deployment): the deep
          // link would be a full-screen AccessDenied, so say who CAN act instead.
          gate.upsellAdvice
        )}
      </span>
    </Callout>
  );
}

/**
 * A toolbar action the viewer's plan doesn't include, rendered as a muted,
 * lock-marked control instead of being hidden.
 *
 * Hiding it is what produced "does this product even do bulk import?"; leaving
 * it enabled is what produced the 403 on click. This third option keeps the
 * affordance visible, names the entitlement in its tooltip/label, and leads to
 * the one page where the viewer can do something about it.
 *
 * Render only when the viewer WOULD otherwise have the control (they hold the
 * write permission) — a lock on something they couldn't use anyway is noise.
 */
export function FeatureLockedAction({ flag, label, icon: Icon, iconOnly = false }: {
  flag: FeatureFlag;
  label: string;
  icon?: LucideIcon;
  /** Toolbar-icon form (e.g. the top bar's Ask): the icon with a lock badge, no
   *  visible text. The accessible name and tooltip still say what's locked. */
  iconOnly?: boolean;
}) {
  const gate = useFeatureGate(flag);
  if (!gate.isLoaded || gate.entitled) return null;
  // The action leads to billing only for a viewer who can open it. For everyone
  // else it stays visible and named, but renders as an inert (aria-disabled,
  // still focusable) button whose name says who to ask — a link to a page that
  // would AccessDeny them is a worse dead end than the lock itself.
  // A tier-only entitlement names its plan here too — the tooltip is the only
  // thing this control says, so "add it" would send the viewer looking for an
  // add-on that isn't on sale.
  const included = gate.includedFromPlan ? ` It comes with the ${gate.includedFromPlan} plan.` : '';
  const title = gate.canUpsell
    ? `${label} needs ${gate.label}, which isn't included in your current plan.${included}`
    : `${label} needs ${gate.label}, which isn't included in your current plan.${included} ${gate.upsellAdvice}`;
  const common = {
    title,
    'aria-label': gate.canUpsell
      ? `${label} — requires ${gate.label}.${included} Open billing to ${gate.includedFromPlan ? 'compare plans' : 'add it'}.`
      : `${label} — requires ${gate.label}, not included in your plan.${included} ${gate.upsellAdvice}`,
    'data-testid': `feature-locked-${flag}`,
  };
  const className = iconOnly
    ? 'relative p-1.5 rounded-full text-fg-subtle hover:text-fg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors'
    : 'btn btn-secondary opacity-60 hover:opacity-100';
  const body = iconOnly ? (
    <>
      {Icon ? <Icon className="w-5 h-5" aria-hidden="true" /> : null}
      <Lock className="absolute -bottom-0.5 -right-0.5 w-3 h-3" aria-hidden="true" />
    </>
  ) : (
    <>
      {Icon ? <Icon className="w-4 h-4 mr-2" aria-hidden="true" /> : null}
      {label}
      <Lock className="w-3.5 h-3.5 ml-2" aria-hidden="true" />
    </>
  );
  if (!gate.canUpsell) {
    return (
      <button type="button" aria-disabled="true" {...common} className={className}>
        {body}
      </button>
    );
  }
  return (
    <Link href={gate.upsellHref} {...common} className={className}>
      {body}
    </Link>
  );
}
