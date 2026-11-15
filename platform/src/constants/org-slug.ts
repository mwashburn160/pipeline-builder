// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one org slug rule, shared by the Organization model's auto-generator
 * (helpers/org-slug.ts), the slug edit schema (`utils/validation.ts`) and the
 * per-org k8s namespace render (`controllers/org-namespace.ts`), so a
 * generated slug always saves back unchanged and always yields a valid
 * namespace name.
 */

/** Prefix of the per-org k8s namespace: `pb-org-<slug>`. */
export const ORG_NAMESPACE_PREFIX = 'pb-org-';

/** DNS-1123 label ceiling for a k8s namespace name. */
export const K8S_NAMESPACE_MAX = 63;

export const ORG_SLUG_MIN = 2;

/** 63 − `pb-org-`.length: the longest slug whose namespace is still a valid
 *  DNS-1123 label. */
export const ORG_SLUG_MAX = K8S_NAMESPACE_MAX - ORG_NAMESPACE_PREFIX.length;

/** Lowercase alphanumeric words joined by single hyphens (no leading,
 *  trailing or doubled hyphens). */
export const ORG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
