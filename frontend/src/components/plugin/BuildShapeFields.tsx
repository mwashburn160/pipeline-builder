// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Lock } from 'lucide-react';
import {
  BUILD_SIZES,
  BUILD_CLASS_CATALOG,
  BUILD_SIZE_CATALOG,
  buildSizeLabel,
  buildSlotsByClass,
  buildSizesForTier,
  defaultClassForSize,
  tierAllowsBuildSize,
  type BuildClass,
  type BuildSize,
} from '@pipeline-builder/api-core/build-catalog';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { TIER_META } from '@/lib/tiers';
import type { QuotaTier } from '@/types';

/**
 * The machine a build runs on, and whether it may start later (D11/D13).
 *
 * ONE select over five named sizes — Small, Standard, Medium, Large, X-Large —
 * rather than two dropdowns over a class and a multiple. The two ids are still
 * what goes on the wire, but a size carries the class it belongs with
 * (`defaultClassForSize`), so picking "Small" also puts the build in the
 * `flexible` class without the user having to learn why: a half-speed build
 * holds its slot about twice as long, and on Developer's single standard slot
 * that would block the only urgent-fix slot for double the time.
 *
 * The deferral checkbox keeps the other combination reachable. A big nightly
 * image that can start whenever is a legitimate `flexible` + `Large`, and a
 * preset list that could not express it would push that build into the standard
 * class — the worst cell for the platform.
 *
 * Gated sizes are SHOWN AND LOCKED with the tier that has them, because a
 * capability nobody can see is a reason to upgrade nobody ever learns.
 *
 * `tier` undefined means it is still loading: the size field is suppressed
 * rather than rendered against a guess, since rendering it against `developer`
 * would flash a lock an entitled org does not have.
 */
export function BuildShapeFields({
  tier,
  buildClass,
  buildSize,
  onClassChange,
  onSizeChange,
  disabled = false,
}: {
  tier?: QuotaTier;
  buildClass: BuildClass;
  buildSize: BuildSize;
  onClassChange: (c: BuildClass) => void;
  onSizeChange: (s: BuildSize) => void;
  disabled?: boolean;
}) {
  const slots = tier ? buildSlotsByClass(tier) : undefined;
  const available = tier ? buildSizesForTier(tier) : [];
  const locked = tier ? BUILD_SIZES.filter((s) => !tierAllowsBuildSize(tier, s)) : [];

  // Picking a size also moves the class to the one that size belongs with. An
  // explicit deferral stays sticky, so a user who ticked it keeps it.
  const pickSize = (s: BuildSize) => {
    onSizeChange(s);
    if (buildClass === 'standard') onClassChange(defaultClassForSize(s));
    };

  return (
    <>
      {tier && (
        <FormField
          label="Build machine"
          hint={'A bigger machine finishes sooner. Credits are charged per vCPU-minute, so Small never costs more than '
            + 'Standard and can cost half, while a bigger one costs more unless the build parallelises.'}
        >
          <Select
            value={buildSize}
            onChange={(e) => pickSize(e.target.value as BuildSize)}
            disabled={disabled}
            data-testid="build-size-select"
          >
            {available.map((s) => (
              <option key={s} value={s}>{`${buildSizeLabel(s)} (${s})`}</option>
            ))}
          </Select>
          <ul className="mt-2 space-y-1" data-testid="build-size-ladder">
            {locked.map((s) => (
              <li key={s} className="flex items-center gap-1.5 text-xs text-fg-subtle">
                <Lock className="w-3 h-3 shrink-0" aria-hidden="true" />
                {`${buildSizeLabel(s)} (${s}) · ${tierLabelFor(s)} and above`}
              </li>
            ))}
          </ul>
        </FormField>
      )}

      <FormField
        label="Start"
        hint={slots
          ? `${slots.standard} standard · ${slots.flexible} flexible builds at once on your plan`
          : undefined}
      >
        <label className="flex items-start gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={buildClass === 'flexible'}
            onChange={(e) => onClassChange(e.target.checked ? 'flexible' : 'standard')}
            disabled={disabled}
            data-testid="build-defer-toggle"
          />
          <span>
            <span className="font-medium text-fg">Start when there is room</span>
            {' — '}{BUILD_CLASS_CATALOG.flexible.blurb}
          </span>
        </label>
      </FormField>
    </>
  );
}

/**
 * The display label of the lowest tier that may request `size`.
 *
 * Reads `minTier` off the catalog rather than searching a tier ladder declared
 * here — a local ladder would be exactly the mirror this component was rewritten
 * to delete.
 */
function tierLabelFor(size: BuildSize): string {
  const min = BUILD_SIZE_CATALOG[size].minTier;
  return min ? TIER_META[min].label : '';
}
