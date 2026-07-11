// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { TIER_META, TIER_KEYS as SHARED_TIER_KEYS } from '@/lib/tiers';
import type { QuotaTier, DisplayedQuotaType } from '@/types';
import { DISPLAYED_QUOTA_TYPES } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QUOTA_KEYS: readonly DisplayedQuotaType[] = DISPLAYED_QUOTA_TYPES;

export const QUOTA_META: Record<DisplayedQuotaType, { label: string; description: string }> = {
  plugins: { label: 'Plugins', description: 'Container images deployed' },
  pipelines: { label: 'Pipelines', description: 'Pipeline configurations' },
  apiCalls: { label: 'API Calls', description: 'Requests this period' },
  aiCalls: { label: 'AI Calls', description: 'AI generation invocations this period' },
};

export const TIER_KEYS: QuotaTier[] = [...SHARED_TIER_KEYS];

// Tier descriptions + quota limits stay local — they're page-specific and
// not appropriate for the shared TIER_META catalog. Label and dot color
// now come from TIER_META so renames stay in one place.
const TIER_DESCRIPTIONS: Record<QuotaTier, string> = {
  developer: 'Starter tier',
  pro: 'Production use',
  team: 'Team collaboration',
  enterprise: 'Highest limits',
};

const TIER_LIMITS: Record<QuotaTier, Record<DisplayedQuotaType, number>> = {
  developer: { pipelines: 5, plugins: 25, apiCalls: 25000, aiCalls: 50 },
  pro: { pipelines: 10, plugins: 50, apiCalls: 500000, aiCalls: 2500 },
  team: { pipelines: 200, plugins: 100, apiCalls: -1, aiCalls: 10000 },
  enterprise: { pipelines: 200, plugins: 250, apiCalls: -1, aiCalls: 25000 },
};

export const TIER_PRESETS: Record<QuotaTier, { label: string; description: string; color: string; limits: Record<DisplayedQuotaType, number> }> = {
  developer:  { label: TIER_META.developer.label,  description: TIER_DESCRIPTIONS.developer,  color: TIER_META.developer.dotClass,  limits: TIER_LIMITS.developer },
  pro:        { label: TIER_META.pro.label,        description: TIER_DESCRIPTIONS.pro,        color: TIER_META.pro.dotClass,        limits: TIER_LIMITS.pro },
  team:       { label: TIER_META.team.label,       description: TIER_DESCRIPTIONS.team,       color: TIER_META.team.dotClass,       limits: TIER_LIMITS.team },
  enterprise: { label: TIER_META.enterprise.label, description: TIER_DESCRIPTIONS.enterprise, color: TIER_META.enterprise.dotClass, limits: TIER_LIMITS.enterprise },
};
