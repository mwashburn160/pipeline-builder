// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Breached-password check against Have I Been Pwned's "Pwned Passwords" range
 * API, using its k-anonymity model:
 *
 *   1. SHA-1 the candidate password (uppercase hex);
 *   2. send ONLY the first 5 characters — `GET <rangeUrl><prefix>`;
 *   3. compare the remaining 35 characters against the ~800 suffixes returned,
 *      locally. The password, its full hash and the match result never leave
 *      the process.
 *
 * `Add-Padding: true` asks the API to pad every response with fake zero-count
 * suffixes, so even the response SIZE says nothing about the prefix; padded
 * entries (count 0) are ignored.
 *
 * FAILURE MODE — FAIL OPEN (see `config.auth.passwordBreachCheck`). A timeout,
 * a network error or a non-200 answer lets the password through as
 * `unavailable`, metered on `platform_password_breach_checks_total` so an
 * outage is visible (and alertable) rather than silent. Blocking registration,
 * password changes and admin resets on a third party's uptime would turn an
 * HIBP incident into a platform incident, and this check is defence-in-depth on
 * top of the length/complexity rules and the login throttle.
 */

import crypto from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { incCounter } from '../observability/metrics.js';

const logger = createLogger('password-breach');

/** What one check concluded. `skipped` = the check is configured off. */
export type BreachOutcome = 'breached' | 'clean' | 'unavailable' | 'skipped';

export interface BreachCheckResult {
  outcome: BreachOutcome;
  /** How many times the password appears in the corpus (only when `breached`). */
  count?: number;
}

/** Uppercase hex SHA-1 split into the 5-char prefix sent and the suffix kept. */
export function breachHashParts(password: string): { prefix: string; suffix: string } {
  const hex = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

/**
 * Find `suffix` in a range-API body (`SUFFIX:COUNT` per line). Returns the
 * count, or 0 when absent — including a padded entry, whose count is 0.
 */
export function breachCountInRange(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const [candidate, rawCount] = line.trim().split(':');
    if (candidate?.toUpperCase() !== suffix) continue;
    const count = Number.parseInt(rawCount ?? '0', 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  return 0;
}

/** Check one password. Never throws — see the failure-mode note above. */
export async function checkPasswordBreach(password: string): Promise<BreachCheckResult> {
  const settings = config.auth.passwordBreachCheck;
  if (settings.mode === 'off') return { outcome: 'skipped' };

  const { prefix, suffix } = breachHashParts(password);
  let result: BreachCheckResult;
  try {
    const res = await fetch(`${settings.rangeUrl}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'pipeline-builder-platform' },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!res.ok) throw new Error(`range API answered ${res.status}`);
    const count = breachCountInRange(await res.text(), suffix);
    result = count > 0 ? { outcome: 'breached', count } : { outcome: 'clean' };
  } catch (err) {
    // Never log the prefix: on its own it is harmless, but it is the one piece
    // of the password this module ever handles outside the hash.
    logger.warn('Breached-password check unavailable; allowing the password (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    result = { outcome: 'unavailable' };
  }
  incCounter('platform_password_breach_checks_total', { outcome: result.outcome });
  return result;
}
