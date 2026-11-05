// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Lock } from 'lucide-react';
import {
  BUILD_CLASSES,
  BUILD_CLASS_CATALOG,
  BUILD_SIZES,
  BUILD_SIZE_CATALOG,
  buildSizeLabel,
  buildSlotsByClass,
  buildSizesForTier,
  tierAllowsBuildSize,
} from '@pipeline-builder/api-core/build-catalog';
import { Card } from '@/components/ui/Card';
import { TIER_META } from '@/lib/tiers';
import type { QuotaTier } from '@/types';

/**
 * What the org's plan gives it in BUILD CAPACITY, beside the quota cards.
 *
 * Capacity is not a quota and does not belong on a quota card: a slot is not
 * spent, it is occupied and given back, and a machine size is a capability
 * rather than an allowance. But it is the other half of the same question — "why
 * is my build waiting?" — and the credits card is where somebody comes looking,
 * so it goes on the same page.
 *
 * Gated sizes are SHOWN AND LOCKED with the tier that has them. A size nobody
 * can see is a reason to upgrade nobody ever learns, and this is the surface
 * where that ladder is supposed to be legible.
 */
export function BuildCapacityCard({ tier }: { tier: QuotaTier }) {
  const slots = buildSlotsByClass(tier);
  const available = buildSizesForTier(tier);
  const locked = BUILD_SIZES.filter((s) => !tierAllowsBuildSize(tier, s));

  return (
    <Card data-testid="build-capacity-card">
      <h3 className="text-sm font-semibold text-fg">Build capacity</h3>
      <p className="mt-1 text-xs text-fg-muted">
        How many builds this organization can run at once, and how big a machine they may ask for. Not an allowance —
        a slot is occupied and given back, so nothing here is spent.
      </p>

      <dl className="mt-3 space-y-2">
        {BUILD_CLASSES.map((cls) => (
          <div key={cls} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-fg-muted">
              <span className="font-medium text-fg">{BUILD_CLASS_CATALOG[cls].label}</span>
              {' — '}{BUILD_CLASS_CATALOG[cls].blurb}
            </dt>
            <dd className="text-sm font-semibold tabular-nums text-fg shrink-0">{slots[cls]}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4">
        <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Build machines</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {available.map((s) => (
            <span key={s} className="inline-flex items-center rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg">
              {buildSizeLabel(s)}
            </span>
          ))}
          {locked.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-xs text-fg-subtle"
            >
              <Lock className="w-3 h-3 shrink-0" aria-hidden="true" />
              {`${buildSizeLabel(s)} · ${minTierLabel(s)} and above`}
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-fg-muted">
          Credits are charged per vCPU-minute, so <span className="font-medium">Small</span> never costs more than
          Standard and can cost half, while a bigger machine finishes sooner and costs more unless the build
          parallelises.
        </p>
      </div>
    </Card>
  );
}

/** The display label of the lowest tier that may request `size`. */
function minTierLabel(size: (typeof BUILD_SIZES)[number]): string {
  const min = BUILD_SIZE_CATALOG[size].minTier;
  return min ? TIER_META[min].label : '';
}
