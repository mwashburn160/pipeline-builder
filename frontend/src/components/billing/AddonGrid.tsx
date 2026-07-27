// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { FEATURE_METADATA, type FeatureFlag } from '@/lib/feature-flags';
import type { Bundle, BillingInterval } from '@/types';

interface AddonGridProps {
  bundles: Bundle[];
  billingInterval: BillingInterval;
  bundleSelfService: boolean;
  actionLoading: boolean;
  previewLoading: boolean;
  addonQty: (bundleId: string) => number;
  requestAddonChange: (bundleId: string, name: string, quantity: number) => void;
  /** Feature flag to emphasize + scroll to (from `?highlight=` on billing). */
  highlightFeature?: string | null;
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
  actionLoading,
  previewLoading,
  addonQty,
  requestAddonChange,
  highlightFeature = null,
}: AddonGridProps) {
  // Deep-link target: the first bundle that grants the highlighted feature
  // (e.g. an "Unlock Advanced Reporting" CTA lands on ?highlight=advanced_reporting).
  const highlightedId = highlightFeature
    ? bundles.find((b) => b.features?.includes(highlightFeature))?.id ?? null
    : null;
  const highlightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightedId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId]);

  return (    <div className="mt-10">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">Add-ons</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {bundleSelfService
          ? 'Buy extra capacity that stacks on your plan and pools across your teams.'
          : 'Extra capacity that stacks on your plan and pools across your teams. This account is billed through AWS Marketplace — add or remove add-ons from your AWS Marketplace subscription.'}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {bundles.map((b) => {
          const qty = addonQty(b.id);
          const price = billingInterval === 'annual' ? b.prices.annual: b.prices.monthly;
          const features = featureLabels(b.features);
          const isHighlighted = b.id === highlightedId;
          return (                  <div
              key={b.id}
              ref={isHighlighted ? highlightRef : undefined}
              className={`card flex flex-col scroll-mt-24 transition-shadow ${
                isHighlighted ? 'ring-2 ring-blue-500 dark:ring-blue-400 shadow-lg' : ''
              }`}
            >
              <div className="flex items-start justify-between">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">{b.name}</h3>
                <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  ${(price / 100).toFixed(2)}/{billingInterval === 'annual' ? 'yr': 'mo'}{b.stackable ? ' ea': ''}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 flex-1">{b.description}</p>
              {features.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-gray-400 dark:text-gray-500">Unlocks</span>
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
              <div className="mt-4 flex items-center gap-2">
                {!bundleSelfService ? (                        <span className="text-sm text-gray-500 dark:text-gray-400">
                    {qty > 0 ? `${qty} active` : 'Managed in AWS Marketplace'}
                  </span>
                ): b.stackable ? (                        <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionLoading || previewLoading || qty === 0}
                      onClick={() => requestAddonChange(b.id, b.name, qty - 1)}
                      aria-label={`Remove one ${b.name}`}
                    >&minus;</Button>
                    <span className="w-10 text-center tabular-nums">{qty}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionLoading || previewLoading}
                      onClick={() => requestAddonChange(b.id, b.name, qty + 1)}
                      aria-label={`Add one ${b.name}`}
                    >+</Button>
                  </>
                ): (                        <Button
                    variant={qty > 0 ? 'secondary': 'primary'}
                    size="sm"
                    disabled={actionLoading || previewLoading}
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
