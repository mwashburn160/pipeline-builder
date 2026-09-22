// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import { Star } from 'lucide-react';
import { starsLabel } from '@/lib/plugin-reviews';

const STARS = [1, 2, 3, 4, 5] as const;

/** Five stars, `rating` of them filled. Read as "4 out of 5 stars". */
export function Stars({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${rating} out of 5 stars`}>
      {STARS.map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          className={`${cls} ${n <= rating ? 'fill-current text-warning' : 'text-fg-subtle'}`}
        />
      ))}
    </span>
  );
}

/**
 * The 1–5 star input: a real radio group (arrow keys move, one tab stop), with
 * each radio visually a star and labelled "3 stars".
 */
export function StarRatingInput({
  value, onChange, disabled = false, legend = 'Your rating',
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
  legend?: string;
}) {
  const name = useId();
  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend className="text-sm font-medium text-fg">{legend} <span className="text-danger-strong" aria-hidden="true">*</span></legend>
      <div className="flex items-center gap-1">
        {STARS.map((n) => (
          <label key={n} className="cursor-pointer rounded focus-within:ring-2 focus-within:ring-[color:var(--pb-ring)]">
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              className="sr-only"
              aria-label={starsLabel(n)}
              required
            />
            <Star
              aria-hidden="true"
              className={`h-6 w-6 ${n <= value ? 'fill-current text-warning' : 'text-fg-subtle'}`}
            />
          </label>
        ))}
        {value > 0 && <span className="ml-2 text-xs text-fg-muted">{starsLabel(value)}</span>}
      </div>
    </fieldset>
  );
}
