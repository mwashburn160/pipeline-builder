// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `publishRotaCoverage` — the absence check on-call paging relies on to see a
 * scheduling gap. The rule that decides whether `OnCallScheduleGap` is honest:
 * an UNKNOWN answer writes no gauge (a 0 would read as "fully covered").
 *
 * Also pins that it publishes through platform's OWN metric helpers: it used to
 * import api-server's, whose registry platform's /metrics never serves, so the
 * gauge the alert reads was emitted nowhere.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

let coverage: { known: boolean; entries?: number; uncoveredSeconds?: number } = { known: false };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  onCallInboundConfig: () => ({ lookaheadHours: 168 }),
  fetchRotaCoverage: async () => coverage,
}));
const incCounter = jest.fn();
const setGauge = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (...a: unknown[]) => incCounter(...a),
  setGauge: (...a: unknown[]) => setGauge(...a),
}));

const { publishRotaCoverage } = await import('../src/services/oncall-rota.js');

beforeEach(() => { incCounter.mockClear(); setGauge.mockClear(); });

describe('publishRotaCoverage', () => {
  it('writes NO gauge when coverage is unknown, and counts the unknown read', async () => {
    coverage = { known: false };
    await publishRotaCoverage();
    expect(setGauge).not.toHaveBeenCalled();
    expect(incCounter).toHaveBeenCalledWith('oncall_rota_reads_total', { outcome: 'unknown' });
  });

  it('publishes the uncovered seconds of a rota with a gap', async () => {
    coverage = { known: true, entries: 2, uncoveredSeconds: 7200 };
    await publishRotaCoverage();
    expect(setGauge).toHaveBeenCalledWith('oncall_schedule_uncovered_seconds', {}, 7200);
    expect(incCounter).toHaveBeenCalledWith('oncall_rota_reads_total', { outcome: 'covered' });
  });

  it('publishes 0 for a fully covered rota', async () => {
    coverage = { known: true, entries: 3, uncoveredSeconds: 0 };
    await publishRotaCoverage();
    expect(setGauge).toHaveBeenCalledWith('oncall_schedule_uncovered_seconds', {}, 0);
  });

  it('an empty rota is "uncovered" and its whole window is the gap', async () => {
    coverage = { known: true, entries: 0, uncoveredSeconds: 168 * 3600 };
    await publishRotaCoverage();
    expect(incCounter).toHaveBeenCalledWith('oncall_rota_reads_total', { outcome: 'uncovered' });
    expect(setGauge).toHaveBeenCalledWith('oncall_schedule_uncovered_seconds', {}, 168 * 3600);
  });
});
