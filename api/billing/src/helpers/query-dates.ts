// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseQueryString } from '@pipeline-builder/api-core';

/**
 * Parse an optional ISO date query param: `undefined` if absent, `null` if
 * malformed (so the route can 400), else the Date. Shared by the usage and
 * billing-summary routes so they validate date ranges identically.
 */
export function parseOptionalDate(raw: unknown): Date | undefined | null {
  const s = parseQueryString(raw);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
