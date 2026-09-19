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
        <Link href={gate.upsellHref} className="font-medium underline underline-offset-2">
          See it in Billing
        </Link>
        {' '}to add it to your plan.
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
  const common = {
    href: gate.upsellHref,
    title: `${label} needs ${gate.label}, which isn't included in your current plan.`,
    'aria-label': `${label} — requires ${gate.label}. Open billing to add it.`,
    'data-testid': `feature-locked-${flag}`,
  };
  if (iconOnly) {
    return (
      <Link
        {...common}
        className="relative p-1.5 rounded-full text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        {Icon ? <Icon className="w-5 h-5" aria-hidden="true" /> : null}
        <Lock className="absolute -bottom-0.5 -right-0.5 w-3 h-3" aria-hidden="true" />
      </Link>
    );
  }
  return (
    <Link {...common} className="btn btn-secondary opacity-60 hover:opacity-100">
      {Icon ? <Icon className="w-4 h-4 mr-2" aria-hidden="true" /> : null}
      {label}
      <Lock className="w-3.5 h-3.5 ml-2" aria-hidden="true" />
    </Link>
  );
}
