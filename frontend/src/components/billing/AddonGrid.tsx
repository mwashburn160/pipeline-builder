// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Button } from '@/components/ui/Button';
import type { Bundle, BillingInterval } from '@/types';

interface AddonGridProps {
  bundles: Bundle[];
  billingInterval: BillingInterval;
  bundleSelfService: boolean;
  actionLoading: boolean;
  previewLoading: boolean;
  addonQty: (bundleId: string) => number;
  requestAddonChange: (bundleId: string, name: string, quantity: number) => void;
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
}: AddonGridProps) {
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
          return (                  <div key={b.id} className="card flex flex-col">
              <div className="flex items-start justify-between">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">{b.name}</h3>
                <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  ${(price / 100).toFixed(2)}/{billingInterval === 'annual' ? 'yr': 'mo'}{b.stackable ? ' ea': ''}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 flex-1">{b.description}</p>
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
