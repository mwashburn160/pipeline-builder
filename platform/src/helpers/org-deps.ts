// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The organization model plus the org-id coercion, resolved LAZILY.
 *
 * The dynamic imports are the point: these helpers are reached from middleware
 * that loads before mongoose connects, and importing the model graph at module
 * load pulls the whole models barrel into every consumer. Keeping the dynamic
 * imports inside the function preserves that, while giving the two callers
 * (`mfa-policy.ts`, `org-policy-lineage.ts`) one copy instead of two identical
 * ones.
 */
export async function orgDeps() {
  const [models, orgId] = await Promise.all([
    import('../models/index.js'),
    import('./org-id.js'),
  ]);
  return { Organization: models.Organization, toOrgId: orgId.toOrgId };
}
