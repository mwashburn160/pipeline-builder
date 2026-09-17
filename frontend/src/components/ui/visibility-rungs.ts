// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Building2, Globe, Lock, type LucideIcon } from 'lucide-react';
import type { Visibility } from '@/types';

/** One rung of the three-rung sharing ladder, as the UI names and draws it. */
export interface VisibilityRung {
  value: Visibility;
  /** Short name — table cells, filters. */
  label: string;
  /** Who can see a row on this rung. */
  meaning: string;
  Icon: LucideIcon;
}

/**
 * The single spelling of the visibility ladder for the UI, narrowest first.
 * Shared by the picker (VisibilitySelect) and the table cell (AccessCell) so a
 * row's rung reads the same wherever it appears.
 */
export const VISIBILITY_RUNGS: readonly VisibilityRung[] = [
  { value: 'private', label: 'Private', meaning: 'only you', Icon: Lock },
  { value: 'org', label: 'Org', meaning: 'everyone in your organization', Icon: Building2 },
  { value: 'public', label: 'Public', meaning: 'shared with your org & its teams', Icon: Globe },
];

/** The rung for `value`, or undefined for a value outside the ladder. */
export function visibilityRung(value: string): VisibilityRung | undefined {
  return VISIBILITY_RUNGS.find((r) => r.value === value);
}
