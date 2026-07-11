// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Check } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { getTierMeta } from '@/lib/tiers';
import type { Plan, Subscription, BillingInterval } from '@/types';

// Plan badge styling comes from the shared TIER_META catalog (`getTierMeta`).
// Border/background tints stay local because they're page-specific accents
// (the "current plan" highlight) rather than a tier identity.
const PLAN_ACCENTS: Record<string, { border: string; bg: string }> = {
  developer:  { border: 'border-green-500',   bg: 'bg-green-50 dark:bg-green-950' },
  pro:        { border: 'border-blue-500',    bg: 'bg-blue-50 dark:bg-blue-950' },
  team:       { border: 'border-purple-500',  bg: 'bg-purple-50 dark:bg-purple-950' },
  enterprise: { border: 'border-amber-500',   bg: 'bg-amber-50 dark:bg-amber-950' },
};

/**
 * Formats a price in cents as a dollar string.
 * @param cents - Price in cents (0 returns "Free").
 * @returns Formatted price string, e.g. "$9.99".
 */
function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

interface PlanGridProps {
  plans: Plan[];
  subscription: Subscription | null;
  billingInterval: BillingInterval;
  actionLoading: boolean;
  canChangePlan: boolean;
  onSubscribe: (planId: string) => void;
}

/** Grid of selectable plan cards with the current-plan highlight. */
export function PlanGrid({
  plans,
  subscription,
  billingInterval,
  actionLoading,
  canChangePlan,
  onSubscribe,
}: PlanGridProps) {
  return (    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {plans.map((plan) => {
        const accents = PLAN_ACCENTS[plan.id] || PLAN_ACCENTS.developer;
        const tierMeta = getTierMeta(plan.id);
        const isCurrent = subscription?.planId === plan.id;
        const price = billingInterval === 'annual' ? plan.prices.annual: plan.prices.monthly;

        return (              <div
            key={plan.id}
            className={`card relative p-6 transition-all ${
              isCurrent
                ? `border-2 ${accents.border} ${accents.bg} shadow-lg`
: 'hover:shadow-md'
            }`}
          >
            {isCurrent && (                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="bg-blue-600 text-white text-xs font-medium px-3 py-1 rounded-full">
                  Current Plan
                </span>
              </div>
            )}

            <div className="text-center mb-6">
              <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${tierMeta.pillClass}`}>
                {plan.name}
              </span>
              <p className="mt-4 text-4xl font-bold text-gray-900 dark:text-gray-100">
                {formatPrice(price)}
              </p>
              {price > 0 && (                    <p className="text-sm text-gray-500 dark:text-gray-400">
                  per {billingInterval === 'annual' ? 'year': 'month'}
                </p>
              )}
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{plan.description}</p>
            </div>

            <ul className="space-y-3 mb-6">
              {plan.features.map((feature) => (                    <li key={feature} className="flex items-start text-sm text-gray-700 dark:text-gray-300">
                  <Check className="w-4 h-4 mr-2 mt-0.5 text-green-500 flex-shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>

            <button
              onClick={() => onSubscribe(plan.id)}
              disabled={isCurrent || actionLoading || !canChangePlan}
              className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
                isCurrent || !canChangePlan
                  ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed'
: 'btn btn-primary justify-center'
              }`}
            >
              {actionLoading ? (                    <LoadingSpinner size="sm" />
              ): isCurrent ? (                    'Current Plan'
              ): subscription ? (                    'Switch to this plan'
              ): (                    'Get Started'
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
