// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BadgeColor } from '@/components/ui/Badge';
import { Badge } from './Badge';
import type { Lifecycle } from '@/types';

/** Lifecycle → Badge color. */
const LIFECYCLE_COLOR: Record<Lifecycle, BadgeColor> = {
  production: 'green',
  experimental: 'yellow',
  deprecated: 'gray',
};

/**
 * Shared lifecycle pill so every surface (My Services, pipeline/plugin detail, …)
 * renders the `lifecycle` field identically. The column is `notNull` with a
 * DEFAULT, so there is no unset case to fall back for.
 */
export function LifecycleBadge({ value }: { value: Lifecycle }) {
  return <Badge color={LIFECYCLE_COLOR[value]}>{value}</Badge>;
}
