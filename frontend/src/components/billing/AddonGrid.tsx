// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FEATURE_METADATA, type FeatureFlag } from '@/lib/feature-flags';
import { formatCents } from '@/lib/format';
import { sellableTiers, tierAvailabilityLabel } from '@/lib/addon-tiers';
import { TIER_META } from '@/lib/tiers';
import type { Bundle, BillingInterval, ComboDiscount } from '@/types';

/** Where an AWS Marketplace buyer manages the subscription that owns their add-ons. */
const AWS_MARKETPLACE_LIBRARY_URL = 'https://aws.amazon.com/marketplace/library';

/** Above this many units, confirm before committing (fat-finger guard). */
const QUANTITY_CONFIRM_THRESHOLD = 100;

/** Pack name without its parenthetical size, pluralized — "Plugin Pack (+25)" → "Plugin Packs". */
function packNoun(name: string): string {
  return `${name.replace(/\s*\(.*\)\s*$/, '')}s`;
}

/**
 * Typed quantity entry for every stackable pack: enter an EXACT count. Because
 * the addon quantity is SET (not incremented), the control shows current → new →
 * delta so a typed "3" reads as "set to 3", alongside what that costs. A bare
 * ±1 stepper hid both the resulting quantity and its price, and let a buyer
 * click past a pack's `maxQuantity` into a server-side 400.
 */
function PackQuantityEntry({ bundle, qty, interval, disabled, requestAddonChange }: {
  bundle: Bundle;
  qty: number;
  interval: BillingInterval;
  disabled: boolean;
  requestAddonChange: (bundleId: string, name: string, quantity: number) => void;
}) {
  const [value, setValue] = useState(String(qty));
  // Re-sync the field when the committed quantity changes (e.g. after a purchase).
  useEffect(() => setValue(String(qty)), [qty]);

  const max = bundle.maxQuantity;
  // An empty / non-numeric / negative field is NOT a "set to 0" — treat it as "no
  // change" so clearing the box (or a fat-finger) can't silently remove everything.
  const trimmed = value.trim();
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  const overMax = Number.isFinite(parsed) && max !== undefined && parsed > max;
  const valid = Number.isFinite(parsed) && parsed >= 0 && !overMax;
  const target = valid ? Math.floor(parsed) : qty;
  const delta = target - qty;
  const unit = interval === 'annual' ? bundle.prices.annual : bundle.prices.monthly;
  const per = interval === 'annual' ? 'yr' : 'mo';
  const noun = packNoun(bundle.name);
  const tiers = (bundle.volumeTiers ?? [])
    .map((t) => `${t.minQuantity}+: ${t.discountPercent}% off`)
    .join(' · ');
  // Volume tiers price the line below list, so the running total is an upper bound.
  const total = `${formatCents(unit * target)}/${per}${tiers ? ' before discounts' : ''}`;

  const submit = () => {
    if (!valid || delta === 0) return;
    // Confirm on a large INCREASE (fat-finger charge) OR a destructive DECREASE
    // (removing all, or a big chunk of, the packs).
    const bigIncrease = target >= QUANTITY_CONFIRM_THRESHOLD;
    const bigDecrease = target === 0 || delta <= -Math.max(5, Math.ceil(qty / 2));
    // Seats are the one dimension a reduction can strand people on, so they get
    // the sharper warning; other packs just lose the capacity they add.
    const lowered = bundle.grants?.seats
      ? `Reduce ${noun} from ${qty} to ${target}? Members over the new limit can't be added back without buying seats again.`
      : `Reduce ${noun} from ${qty} to ${target}? That removes the extra capacity they add.`;
    const msg = target < qty ? lowered : `Set ${noun} to ${target}? That's ${total}.`;
    if ((bigIncrease || bigDecrease) && !window.confirm(msg)) return;
    requestAddonChange(bundle.id, bundle.name, target);
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={max}
          className="input w-24"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          aria-label={`Number of ${noun}`}
          aria-describedby={`${bundle.id}-qty-delta`}
        />
        <Button size="sm" disabled={disabled || !valid || delta === 0} onClick={submit}>
          {qty === 0 ? 'Add' : 'Update'}
        </Button>
      </div>
      <p id={`${bundle.id}-qty-delta`} aria-live="polite" className="mt-1 text-xs text-[var(--pb-text-muted)] tabular-nums">
        {overMax
          ? `Capped at ${max}`
          : `${qty} → ${target}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''} · ${total}`}
      </p>
      {tiers && <p className="mt-0.5 text-xs text-[var(--pb-text-muted)]">Volume discount — {tiers}</p>}
    </div>
  );
}

interface AddonGridProps {
  bundles: Bundle[];
  billingInterval: BillingInterval;
  bundleSelfService: boolean;
  /** Whether the account has an active subscription. `false` renders the catalog
   *  as a read-only PREVIEW (packs stack on a plan, so there's nothing to attach
   *  them to yet) with a "Subscribe to add" affordance. Defaults `true`. */
  subscribed?: boolean;
  actionLoading: boolean;
  previewLoading: boolean;
  /** True while an add-on change is staged in the preview modal. Disables the
   *  seat inputs / +/- controls so a stray Enter can't fire a SECOND
   *  `requestAddonChange` and swap the staged change out from under the modal. */
  changePending?: boolean;
  addonQty: (bundleId: string) => number;
  requestAddonChange: (bundleId: string, name: string, quantity: number) => void;
  /** Feature flag to emphasize + scroll to (from `?highlight=` on billing). */
  highlightFeature?: string | null;
  /** Combo discounts advertised for this account (bundle pairs billed together
   *  at a reduced price). Drives the "pair to save" nudge. */
  comboDiscounts?: ComboDiscount[];
  /** Preview-state CTA: the buyer wants this pack but has no plan to stack it on.
   *  Takes them to plan selection (and is remembered, so they land back here after
   *  subscribing). Without it the preview card renders as static text. */
  onSubscribeIntent?: (bundle: Bundle) => void;
}

/** Human labels for the feature flags a bundle grants (unknown flags pass through raw). */
function featureLabels(features?: string[]): string[] {
  if (!features?.length) return [];
  return features.map((f) => FEATURE_METADATA[f as FeatureFlag]?.label ?? f);
}

/** Add-on bundles — extra capacity that stacks on the base plan and
 *  pools across the account's teams. */
export function AddonGrid({
  bundles,
  billingInterval,
  bundleSelfService,
  subscribed = true,
  actionLoading,
  previewLoading,
  changePending = false,
  addonQty,
  requestAddonChange,
  highlightFeature = null,
  comboDiscounts = [],
  onSubscribeIntent,
}: AddonGridProps) {
  // Packs can only be purchased when self-service is allowed AND there's a plan to
  // stack them on. Otherwise the catalog renders read-only (a preview / marketplace-
  // managed view).
  const canBuy = bundleSelfService && subscribed;
  // Every mutating control is disabled while a request is in flight OR a change is
  // already staged in the preview modal (else the re-enabled input could fire a
  // second requestAddonChange behind the open modal).
  const controlsDisabled = actionLoading || previewLoading || changePending;
  // "Pair to save" nudge for a bundle: fires when adding this bundle would COMPLETE a
  // combo — i.e. this member is below its minimum quantity while every OTHER member is
  // already at its minimum. A member is *satisfied* at `addonQty(id) >= minQty(id)`.
  // When a card completes several combos, show only the single highest-savings one
  // (packing means overlapping combos won't both pay out).
  const minQty = (combo: ComboDiscount, id: string) => combo.minQuantities?.[id] ?? 1;
  const comboNudge = (bundleId: string): string | null => {
    let best: { name: string; save: number } | null = null;
    for (const combo of comboDiscounts) {
      if (!combo.bundleIds.includes(bundleId) || addonQty(bundleId) >= minQty(combo, bundleId)) continue;
      const others = combo.bundleIds.filter((id) => id !== bundleId);
      if (others.length === 0 || !others.every((id) => addonQty(id) >= minQty(combo, id))) continue;
      const save = billingInterval === 'annual' ? combo.savings.annual : combo.savings.monthly;
      if (save > 0 && (!best || save > best.save)) best = { name: combo.name, save };
    }
    return best ? `Completes the ${best.name} — save ${formatCents(best.save)}/${billingInterval === 'annual' ? 'yr' : 'mo'}` : null;
  };
  // Deep-link target for `?highlight=<key>`: match a bundle by the feature it
  // grants (e.g. `advanced_reporting`), OR directly by bundle id / name — so a
  // capacity pack with no feature flag (e.g. `dora_history_pack`, the retention
  // pack) is still reachable from a CTA. Case-insensitive on id/name.
  const highlightedId = (() => {
    if (!highlightFeature) return null;
    const key = highlightFeature.toLowerCase();
    const match = bundles.find(
      (b) =>
        b.features?.includes(highlightFeature) ||
        b.id.toLowerCase() === key ||
        b.name.toLowerCase() === key,
    );
    return match?.id ?? null;
  })();
  // In the preview, lead with the packs the cheapest plan can buy: the catalog's
  // own order opens on a Team-only pack, the least reachable card on the page.
  // `sort` is stable, so catalog order survives within each tier group. Once
  // subscribed the list is already tier-filtered — leave it alone.
  const orderedBundles = subscribed
    ? bundles
    : [...bundles].sort((a, b) => {
      const rank = (x: Bundle) => sellableTiers(x).map((t) => TIER_META[t].sort)[0] ?? Number.MAX_SAFE_INTEGER;
      return rank(a) - rank(b);
    });

  const highlightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightedId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId]);

  return (    <div className="mt-10">
      <h2 className="text-lg font-semibold text-[var(--pb-text)] mb-1">Add-ons</h2>
      <p className="text-sm text-[var(--pb-text-muted)] mb-4">
        {!subscribed
          ? 'Preview of the add-on packs available on your plan. Subscribe to a plan to buy extra capacity that stacks on it and pools across your teams.'
          : bundleSelfService
          ? 'Buy extra capacity that stacks on your plan and pools across your teams.'
          : 'Extra capacity that stacks on your plan and pools across your teams. This account is billed through AWS Marketplace — add or remove add-ons from your AWS Marketplace subscription.'}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {orderedBundles.map((b) => {
          const qty = addonQty(b.id);
          const price = billingInterval === 'annual' ? b.prices.annual: b.prices.monthly;
          const features = featureLabels(b.features);
          const nudge = comboNudge(b.id);
          const isHighlighted = b.id === highlightedId;
          return (                  <div
              key={b.id}
              ref={isHighlighted ? highlightRef : undefined}
              className={`card flex flex-col scroll-mt-24 transition-shadow ${
                isHighlighted ? 'ring-2 ring-blue-500 dark:ring-blue-400 shadow-lg' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <h3 className="font-medium text-[var(--pb-text)]">{b.name}</h3>
                <span className="text-sm text-[var(--pb-text-muted)] whitespace-nowrap">
                  {formatCents(price)}/{billingInterval === 'annual' ? 'yr': 'mo'}{b.stackable ? ' ea': ''}
                </span>
              </div>
              <p className="text-sm text-[var(--pb-text-muted)] mt-1 flex-1">{b.description}</p>
              {features.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[var(--pb-text-muted)]">Unlocks</span>
                  {features.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
              {!subscribed && tierAvailabilityLabel(b) && (
                <p className="mt-2 text-xs text-[var(--pb-text-muted)]">{tierAvailabilityLabel(b)}</p>
              )}
              {nudge && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-green-50 dark:bg-green-900/30 px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300">
                  {nudge}
                </p>
              )}
              <div className="mt-4 flex items-center gap-2">
                {!subscribed ? (
                  onSubscribeIntent ? (
                    <Button size="sm" onClick={() => onSubscribeIntent(b)}>
                      Subscribe to add →
                    </Button>
                  ) : (
                    <span className="text-sm text-[var(--pb-text-muted)]">Subscribe to add</span>
                  )
                ): !canBuy ? (                        <span className="text-sm text-[var(--pb-text-muted)]">
                    {qty > 0 ? (
                      `${qty} active`
                    ) : (
                      <a
                        href={AWS_MARKETPLACE_LIBRARY_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        Manage in AWS Marketplace →
                      </a>
                    )}
                  </span>
                ): b.stackable ? (
                  <PackQuantityEntry
                    bundle={b}
                    qty={qty}
                    interval={billingInterval}
                    disabled={controlsDisabled}
                    requestAddonChange={requestAddonChange}
                  />
                ): (                        <Button
                    variant={qty > 0 ? 'secondary': 'primary'}
                    size="sm"
                    disabled={controlsDisabled}
                    onClick={() => requestAddonChange(b.id, b.name, qty > 0 ? 0: 1)}
                  >
                    {qty > 0 ? 'Remove': 'Add'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
