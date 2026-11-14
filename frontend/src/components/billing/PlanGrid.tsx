// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { getTierMeta } from '@/lib/tiers';
import { formatPrice } from './helpers';
import type { Plan, Subscription, BillingInterval } from '@/types';

// Plan badge AND card accent come from the shared TIER_META catalog
// (`getTierMeta`), so a plan card is the same hue as that tier's pill.

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
        const tierMeta = getTierMeta(plan.id);
        const accents = tierMeta.accent;
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
                <span className="bg-brand text-white text-xs font-medium px-3 py-1 rounded-full">
                  Current Plan
                </span>
              </div>
            )}

            <div className="text-center mb-6">
              <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${tierMeta.pillClass}`}>
                {plan.name}
              </span>
              <p className="mt-4 text-4xl font-bold text-fg">
                {formatPrice(price)}
              </p>
              {price > 0 && (                    <p className="text-sm text-fg-muted">
                  per {billingInterval === 'annual' ? 'year': 'month'}
                </p>
              )}
              <p className="mt-2 text-sm text-fg-muted">{plan.description}</p>
            </div>

            <ul className="space-y-3 mb-6">
              {plan.features.map((feature) => (                    <li key={feature} className="flex items-start text-sm text-fg">
                  <Check className="w-4 h-4 mr-2 mt-0.5 text-success flex-shrink-0" />
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
                  ? 'bg-surface-muted text-fg-muted cursor-not-allowed'
: ''
              }`}
            >
              {actionLoading ? (                    <LoadingSpinner size="sm" />
              ): !selfService ? (                    'Managed in AWS Marketplace'
              ): isCurrent ? (                    'Current Plan'
              ): subscription ? (                    'Switch to this plan'
              ): (                    'Get started'
              )}
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
