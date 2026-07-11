// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Formats an ISO date string as a human-readable date.
 * @param iso - ISO 8601 date string.
 * @returns Localized date string, e.g. "February 25, 2026".
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}
