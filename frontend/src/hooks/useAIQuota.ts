// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useOwnQuota, type OwnQuota } from '@/hooks/useOwnQuota';

/** The caller's org `aiCalls` quota, as {@link useAIQuota} reads it. */
export type AIQuota = OwnQuota;

/**
 * The org's `aiCalls` quota for an AI surface.
 *
 * A named reading of {@link useOwnQuota}: same read-once-then-on-settle cadence,
 * same fail-open-to-null rule. The build surfaces read `cpuCredits` through the
 * same hook, and sharing it is what keeps the two fail-open paths identical —
 * two copies is how one of them ends up failing closed and locking a control the
 * server would have served.
 */
export function useAIQuota(busy = false): { quota: AIQuota | null; refresh: () => void } {
  return useOwnQuota('aiCalls', busy);
}
