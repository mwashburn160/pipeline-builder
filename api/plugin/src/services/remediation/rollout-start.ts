// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bookkeeping of a TENANT rollout start (publish's first attempt, the
 * nightly sweep's retries, a manual POST …/retry), kept in the row's `rollout`
 * jsonb as `startAttempts` / `lastStartStatus` — no column of its own.
 *
 *  - taken: `published` → `rolling_out`, the bookkeeping (and a given-up
 *    error) cleared;
 *  - permanent refusal (a 4xx other than 408 / 429): given up at once;
 *  - transient (5xx, 408, 429, unreachable): retried nightly by the sweep, at
 *    most {@link REMEDIATION_ROLLOUT_START_MAX_ATTEMPTS} attempts in all
 *    (publish's own counted), then given up as `exhausted`.
 *
 * Given up: the row stays `published` (the version is live and choosable) with
 * error {@link REMEDIATION_ROLLOUT_START_FAILED}, the sweep stops retrying it,
 * `plugin_remediation_rollout_start_failures_total{reason}` counts it and the
 * org's plugin security recipients get the N37 "rollout paused" notice (not for
 * a manual restart: the person who pressed Retry sees the answer). Retry on
 * the card starts it again, counting from 1.
 */

import {
  createLogger,
  errorMessage,
  PLUGIN_REMEDIATION_METRICS,
  REMEDIATION_ROLLOUT_START_FAILED,
  REMEDIATION_ROLLOUT_START_MAX_ATTEMPTS,
  type RemediationRolloutStartGiveUp,
  type RemediationRolloutSummary,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { PluginRemediation } from '@pipeline-builder/pipeline-data';

import { readRolloutStart, withoutRolloutStart } from './dto.js';
import type { RolloutStartResult } from './rollout.js';
import { lockedUpdateRemediation } from './store.js';
import { sendRemediationNotice } from '../remediation-notices.js';

const logger = createLogger('plugin-remediation-rollout-start');

/** Who made the attempt: the publish (attempt 1), the nightly sweep (the next one), a person (counts from 1 again). */
export type RolloutStartAttempt = 'publish' | 'sweep' | 'manual';

export interface RecordedRolloutStart {
  /** `stale`: the row was no longer `published` (a report or a cancel got there first); nothing written. */
  outcome: 'started' | 'retrying' | 'given_up' | 'stale';
  row: PluginRemediation | null;
  giveUp?: RemediationRolloutStartGiveUp;
}

type Decided =
  | { outcome: 'stale' | 'started' | 'retrying' }
  | { outcome: 'given_up'; giveUp: RemediationRolloutStartGiveUp; attempts: number; status: string };

/** Record one start's answer on its `published` row (under the row lock), and act on a give-up. */
export async function recordRolloutStart(row: PluginRemediation, result: RolloutStartResult, attempt: RolloutStartAttempt): Promise<RecordedRolloutStart> {
  const applied = await lockedUpdateRemediation<Decided>(row.id, (cur) => {
    if (cur.stage !== 'published') return { patch: null, result: { outcome: 'stale' } };
    const clearError = cur.error === REMEDIATION_ROLLOUT_START_FAILED ? { error: null } : {};
    if (result.ok) {
      return {
        patch: { stage: 'rolling_out', rollout: withoutRolloutStart(cur.rollout) as RemediationRolloutSummary | null, ...clearError },
        result: { outcome: 'started' },
      };
    }
    const prev = readRolloutStart(cur.rollout)?.attempts;
    // A row from before the bookkeeping: its publish made attempt 1.
    const attempts = attempt === 'sweep' ? (prev ?? 1) + 1 : 1;
    const giveUp: RemediationRolloutStartGiveUp | undefined = result.permanent ? 'permanent'
      : attempts >= REMEDIATION_ROLLOUT_START_MAX_ATTEMPTS ? 'exhausted' : undefined;
    const rollout = { ...(withoutRolloutStart(cur.rollout) ?? {}), startAttempts: attempts, lastStartStatus: result.status };
    return {
      patch: { rollout: rollout as unknown as RemediationRolloutSummary, ...(giveUp ? { error: REMEDIATION_ROLLOUT_START_FAILED } : clearError) },
      result: giveUp ? { outcome: 'given_up', giveUp, attempts, status: result.status } : { outcome: 'retrying' },
    };
  });
  if (!applied) return { outcome: 'stale', row: null };
  const r = applied.result;
  if (r.outcome !== 'given_up') return { outcome: r.outcome, row: applied.row };

  const updated = applied.row;
  incCounter(PLUGIN_REMEDIATION_METRICS.rolloutStartFailures, { reason: r.giveUp });
  logger.warn('Remediation rollout start given up', { remediationId: row.id, reason: r.giveUp, attempts: r.attempts, lastStartStatus: r.status, attempt });
  if (attempt !== 'manual') {
    const toVersion = updated.toVersion ?? row.toVersion ?? '';
    await sendRemediationNotice({
      code: 'N37',
      orgId: updated.orgId,
      remediationId: updated.id,
      pluginName: updated.pluginName,
      fromVersion: updated.fromVersion,
      toVersion,
      summary: {
        status: 'paused',
        toVersion,
        waves: [],
        counts: { eligible: 0, proposed: 0, changeRequested: 0, moved: 0, failed: 0, rolledBack: 0, skippedOptOut: 0, skippedRunner: 0 },
        updatedAt: updated.updatedAt.toISOString(),
      },
      startFailure: { reason: r.giveUp, attempts: r.attempts, lastStatus: r.status },
    }).catch((err) => logger.warn('N37 not sent', { remediationId: row.id, error: errorMessage(err) }));
  }
  return { outcome: 'given_up', row: updated, giveUp: r.giveUp };
}
