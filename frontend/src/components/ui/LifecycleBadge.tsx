// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from './Badge';
import type { Lifecycle } from '@/types';

/** Lifecycle → Badge color. */
const LIFECYCLE_COLOR: Record<Lifecycle, 'green' | 'yellow' | 'gray'> = {
  production: 'green',
  experimental: 'yellow',
  deprecated: 'gray',
};

/**
 * Shared lifecycle pill so every surface (My Services, pipeline/plugin detail, …)
 * renders the `lifecycle` field identically. Unset (legacy rows) → "production".
 */
export function LifecycleBadge({ value }: { value?: Lifecycle | null }) {
  const lc: Lifecycle = value ?? 'production';
  return <Badge color={LIFECYCLE_COLOR[lc]}>{lc}</Badge>;
}
