// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mirror of the canonical feature-flag catalog in
 * `packages/api-core/src/types/feature-flags.ts`. The frontend doesn't
 * depend on api-core directly (that package carries Express types we
 * don't want bundled), so we restate the catalog here. Adding a flag
 * means updating both files — the backend validator will reject an
 * unknown override key, so a missed update fails loudly in the UI.
 */

export type FeatureFlag =
  | 'priority_support'
  | 'custom_integrations'
  | 'ai_generation'
  | 'bulk_operations'
  | 'audit_log';

export const ALL_FEATURE_FLAGS: ReadonlyArray<FeatureFlag> = [
  'priority_support',
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'audit_log',
];

export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
  priority_support: { label: 'Priority Support', description: 'Faster response times and dedicated support channels' },
  ai_generation: { label: 'AI Generation', description: 'AI-powered pipeline and plugin generation' },
  bulk_operations: { label: 'Bulk Operations', description: 'Batch create, update, and delete for pipelines and plugins' },
  custom_integrations: { label: 'Custom Integrations', description: 'Connect to external services and custom webhook endpoints' },
  audit_log: { label: 'Audit Log', description: 'Detailed audit trail of all user and system actions' },
};
