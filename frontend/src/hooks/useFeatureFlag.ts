/**
 * @module hooks/useFeatureFlag
 * @description Hooks for checking per-user feature flags resolved by the backend.
 */

import { useAuth } from './useAuth';

/**
 * Check whether a specific feature flag is enabled for the current user.
 *
 * @param flag - The feature flag identifier (e.g., 'advanced_analytics')
 * @returns true if the feature is enabled
 */
export function useFeatureFlag(flag: string): boolean {
  const { user } = useAuth();
  return user?.features?.includes(flag) ?? false;
}

/**
 * Get all enabled feature flags for the current user.
 *
 * @returns Array of enabled feature flag identifiers
 */
export function useFeatureFlags(): string[] {
  const { user } = useAuth();
  return user?.features ?? [];
}
