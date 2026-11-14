// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Building2, Globe, Lock, type LucideIcon } from 'lucide-react';
import type { BadgeColor } from '@/components/ui/Badge';
import type { Visibility } from '@/types';

/** One rung of the three-rung sharing ladder, as the UI names and draws it. */
export interface VisibilityRung {
  value: Visibility;
  /** Short name — table cells, filters. */
  label: string;
  /** Who can see a row on this rung. */
  meaning: string;
  Icon: LucideIcon;
  /** Badge tint — the widest reach is the most prominent. */
  color: BadgeColor;
}

/**
 * The single spelling of the visibility ladder for the UI, narrowest first.
 * Shared by the picker (VisibilitySelect) and the table cell (AccessCell) so a
 * row's rung reads the same wherever it appears.
 */
export const VISIBILITY_RUNGS: readonly VisibilityRung[] = [
  { value: 'private', label: 'Private', meaning: 'only you', Icon: Lock, color: 'gray' },
  { value: 'org', label: 'Org', meaning: 'everyone in your organization', Icon: Building2, color: 'green' },
  { value: 'public', label: 'Public', meaning: 'shared with your org & its teams', Icon: Globe, color: 'blue' },
];

/** The ladder widest first — a filter's order. */
export const VISIBILITY_RUNGS_WIDEST_FIRST: readonly VisibilityRung[] = [...VISIBILITY_RUNGS].reverse();

/** Badge tint for a `visibility` off the wire; a value outside the ladder is grey. */
export function visibilityColor(value: string): BadgeColor {
  return visibilityRung(value)?.color ?? 'gray';
}

/** The rung for `value`, or undefined for a value outside the ladder. */
export function visibilityRung(value: string): VisibilityRung | undefined {
  return VISIBILITY_RUNGS.find((r) => r.value === value);
}
