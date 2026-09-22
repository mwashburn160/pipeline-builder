// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Small shared helpers of the ecosystem services (no I/O). */

import { ErrorCode } from '@pipeline-builder/api-core';
import type { PluginListing } from '@pipeline-builder/pipeline-data';

import { EcosystemError } from './context.js';

export const DAY_MS = 24 * 3_600_000;

/** An ISO timestamp, or null for no date. */
export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** The first row, or null. */
export const first = <T>(rows: T[]): T | null => rows[0] ?? null;

/** A listing counts toward the `listings` quota (and is live in the directory) while in one of these states. */
export const ACTIVE_LISTING_STATES = ['listed', 'unmaintained'] as const;

/** Whether a listing is live in the directory. */
export const isActiveListing = (l: Pick<PluginListing, 'state'>): boolean => (ACTIVE_LISTING_STATES as readonly string[]).includes(l.state);

/** How long a decided submission keeps its submitter email. */
export const EMAIL_RETENTION_DAYS = 90;

/** When a submission decided at `now` has its submitter email purged. */
export const emailPurgeAt = (now: Date): Date => new Date(now.getTime() + EMAIL_RETENTION_DAYS * DAY_MS);

/** A vulnerability id in its canonical form (CVE ids upper-cased). */
export const normalizeVulnId = (id: string): string => (/^cve-/i.test(id) ? id.toUpperCase() : id);

/** `n` rounded to `places` decimals (ratings to 2, hours to 1). */
export const roundTo = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** A trimmed, length-capped free-text field, or null when absent or blank. */
export function optionalText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** A trimmed, length-capped free-text field that must be present (`MISSING_REQUIRED_FIELD` naming `field`). */
export function requiredText(value: unknown, field: string, max: number): string {
  const text = optionalText(value, max);
  if (text === null) throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, `${field} is required`);
  return text;
}
