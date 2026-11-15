// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org slug generation and the per-org namespace-name check. The rule itself
 * (length bounds + shape) lives in constants/org-slug.ts.
 */

import { randomBytes } from 'node:crypto';
import slugify from 'slugify';
import { K8S_NAMESPACE_MAX, ORG_NAMESPACE_PREFIX, ORG_SLUG_MAX, ORG_SLUG_MIN } from '../constants/org-slug.js';

/** Room kept at the end of a generated base slug for a `-<n>` collision
 *  suffix (`-999999`), so `<base>-<n>` never exceeds ORG_SLUG_MAX. */
const SUFFIX_RESERVE = 7;
const BASE_MAX = ORG_SLUG_MAX - SUFFIX_RESERVE;

/**
 * Derive the base slug for an org name. Names that transliterate to nothing
 * usable (CJK, emoji, punctuation-only) get a random `org-<6 hex>` base, so
 * they never collapse onto one shared empty slug.
 */
export function orgSlugBase(name: string): string {
  const slug = slugify(name, { lower: true, strict: true })
    .replace(/-+/g, '-')
    .slice(0, BASE_MAX)
    .replace(/^-+|-+$/g, '');
  if (slug.length < ORG_SLUG_MIN) return `org-${randomBytes(3).toString('hex')}`;
  return slug;
}

/** Build a regex matching `base` and `base-<n>` — the existing slugs that a
 *  new org deriving `base` must not collide with. */
export function orgSlugCollisionPattern(base: string): RegExp {
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-[0-9]+)?$`, 'i');
}

/** Pick `base`, or `base-<max existing suffix + 1>` when `base` is taken. */
export function nextOrgSlug(base: string, existing: readonly string[]): string {
  if (existing.length === 0) return base;
  const suffixes = existing.map((slug) => {
    const m = /-([0-9]+)$/.exec(slug.slice(base.length));
    return m ? parseInt(m[1], 10) : 0;
  });
  return `${base}-${Math.max(0, ...suffixes) + 1}`;
}

/** The k8s namespace name for an org slug. */
export function orgNamespaceName(slug: string): string {
  return `${ORG_NAMESPACE_PREFIX}${slug}`;
}

/** True when `name` is a valid DNS-1123 label (k8s namespace name):
 *  lowercase alphanumeric / hyphen, ≤63 chars, no leading/trailing hyphen. */
export function isValidK8sNamespaceName(name: string): boolean {
  return name.length <= K8S_NAMESPACE_MAX && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name);
}
