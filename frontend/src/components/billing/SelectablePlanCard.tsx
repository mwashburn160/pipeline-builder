// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Check } from 'lucide-react';
import type { Plan } from '@/types';
import { formatPrice } from './helpers';

interface SelectablePlanCardProps {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
  /**
   * `full` — vertical card with a features list + optional "Popular" badge (the
   * signup page). `compact` — horizontal name/price row (the onboarding screen).
   */
  variant?: 'full' | 'compact';
  popular?: boolean;
  disabled?: boolean;
}

/**
 * A selectable plan option shared by the signup and onboarding plan pickers
 * (previously two divergent copies). Both are `type="button"` + `aria-pressed`
 * with the same brand-ring-on-select treatment; the layout differs by `variant`.
 */
export function SelectablePlanCard({
  plan, selected, onSelect, variant = 'full', popular = false, disabled = false,
}: SelectablePlanCardProps) {
  const price = formatPrice(plan.prices.monthly, { suffix: '/mo' });

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-all ${
          selected
            ? 'border-[var(--pb-brand)] ring-2 ring-[color:var(--pb-brand)]'
            : 'border-[var(--pb-border)] hover:border-[var(--pb-text-muted)]'
        }`}
      >
        <span>
          <span className="font-semibold text-sm">{plan.name}</span>
          <span className="block text-xs text-[var(--pb-text-muted)]">{plan.description}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-bold text-[var(--pb-brand)]">{price}</span>
          {selected && <Check className="w-4 h-4 text-[var(--pb-brand)]" />}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`relative flex flex-col rounded-xl border p-3 text-left transition-all ${
        selected
          ? 'border-[var(--pb-brand)] ring-2 ring-[color:var(--pb-brand)] bg-[color:color-mix(in_srgb,var(--pb-brand)_6%,transparent)]'
          : 'border-[var(--pb-border)] hover:border-[var(--pb-text-muted)]'
      }`}
    >
      {popular && (
        <span className="absolute -top-2 right-3 rounded-full bg-[var(--pb-brand)] text-white text-[10px] font-semibold px-2 py-0.5">
          Popular
        </span>
      )}
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm">{plan.name}</span>
        {selected && <Check className="w-3.5 h-3.5 text-[var(--pb-brand)] shrink-0" />}
      </div>
      <div className="text-[var(--pb-brand)] font-bold text-sm mt-0.5">{price}</div>
      <p className="text-xs text-[var(--pb-text-muted)] mt-1 leading-snug">{plan.description}</p>
      <ul className="mt-2 space-y-1">
        {plan.features.slice(0, 4).map((f) => (
          <li key={f} className="flex items-start gap-1.5 text-[11px] text-[var(--pb-text-muted)]">
            <Check className="w-3 h-3 mt-0.5 shrink-0 text-[var(--pb-success)]" strokeWidth={2.5} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </button>
  );
}
