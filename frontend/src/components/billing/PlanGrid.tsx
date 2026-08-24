// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { getTierMeta } from '@/lib/tiers';
import { formatPrice } from './helpers';
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


interface PlanGridProps {
  plans: Plan[];
  subscription: Subscription | null;
  billingInterval: BillingInterval;
  actionLoading: boolean;
  canChangePlan: boolean;
  /** False for Marketplace-billed accounts — plans are managed in AWS, so the CTAs
   *  render read-only ("Managed in AWS Marketplace") instead of active buttons. */
  selfService?: boolean;
  onSubscribe: (planId: string) => void;
}

/** Grid of selectable plan cards with the current-plan highlight. */
export function PlanGrid({
  plans,
  subscription,
  billingInterval,
  actionLoading,
  canChangePlan,
  selfService = true,
  onSubscribe,
}: PlanGridProps) {
  return (    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {plans.map((plan) => {
        const accents = PLAN_ACCENTS[plan.id] || PLAN_ACCENTS.developer;
        const tierMeta = getTierMeta(plan.id);
        const isCurrent = subscription?.planId === plan.id;
        const price = billingInterval === 'annual' ? plan.prices.annual: plan.prices.monthly;

        return (              <Card
            key={plan.id}
            className={`relative p-6 transition-all ${
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
              <p className="mt-4 text-4xl font-bold text-[var(--pb-text)]">
                {formatPrice(price)}
              </p>
              {price > 0 && (                    <p className="text-sm text-[var(--pb-text-muted)]">
                  per {billingInterval === 'annual' ? 'year': 'month'}
                </p>
              )}
              <p className="mt-2 text-sm text-[var(--pb-text-muted)]">{plan.description}</p>
            </div>

            <ul className="space-y-3 mb-6">
              {plan.features.map((feature) => (                    <li key={feature} className="flex items-start text-sm text-[var(--pb-text)]">
                  <Check className="w-4 h-4 mr-2 mt-0.5 text-green-500 flex-shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>

            <Button
              variant="primary"
              fullWidth
              onClick={() => onSubscribe(plan.id)}
              disabled={isCurrent || actionLoading || !canChangePlan || !selfService}
              className={`justify-center ${
                isCurrent || !canChangePlan || !selfService
                  ? 'bg-[var(--pb-surface-muted)] text-[var(--pb-text-muted)] cursor-not-allowed'
: ''
              }`}
            >
              {actionLoading ? (                    <LoadingSpinner size="sm" />
              ): !selfService ? (                    'Managed in AWS Marketplace'
              ): isCurrent ? (                    'Current Plan'
              ): subscription ? (                    'Switch to this plan'
              ): (                    'Get Started'
              )}
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
