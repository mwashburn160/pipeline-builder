// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The retention pass PLANS plugins concurrently, at most
 * RETENTION_PLAN_CONCURRENCY at once, and keeps the catalogue's order in what
 * it reports. A serial walk took ~27s at 129 plugins, past the plan route's
 * deadline, and grew with the catalogue. What a plan decides, and the serial
 * acting stage, are retention-pass.test.ts (real Postgres).
 *
 * Replaced: planPlugin (a timed fake that counts how many run at once), the
 * plugin-name listing, the registry breakdown, the counts and the report builder.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn, stubModule } from '@pipeline-builder/api-core/testing';

const NAMES = Array.from({ length: 13 }, (_, i) => `plugin-${String(i).padStart(2, '0')}`);

let inFlight = 0;
let maxInFlight = 0;
let failName: string | null = null;
const delayFor = (name: string) => 5 + (NAMES.length - NAMES.indexOf(name)) * 2; // later names finish first
const mockPlanPlugin = jest.fn<AnyFn>(async (name: string) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, delayFor(name)));
    if (name === failName) throw new Error('db hiccup');
    return { name, listing: null, facts: [], decision: { decisions: [], deferredCount: 0 } };
  } finally {
    inFlight--;
  }
});
const mockBuildReport = jest.fn<AnyFn>(() => ({ totals: { retirable: 0, stuck: 0 } }));
const mockIncCounter = jest.fn();

const realPlan = await import('../src/services/retention/plan.js');
jest.unstable_mockModule('../src/services/retention/plan.js', () => ({
  ...realPlan,
  planPlugin: mockPlanPlugin,
  elevatedRead: (fn: (tx: unknown) => unknown) => fn({}),
  retirementCounts: async () => ({ awaitingCollection: 0, stuck: 0 }),
  buildReport: mockBuildReport,
}));
const realSelect = await import('../src/services/retention/select.js');
jest.unstable_mockModule('../src/services/retention/select.js', () => ({
  ...realSelect,
  systemPluginNames: async () => NAMES,
}));
const realRegistry = await import('../src/services/ecosystem/registry.js');
jest.unstable_mockModule('../src/services/ecosystem/registry.js', () => ({
  ...realRegistry,
  retentionBreakdown: async () => null,
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: mockIncCounter,
  setGauge: jest.fn(),
}));

const { runRetentionPass, RETENTION_PLAN_CONCURRENCY } = await import('../src/services/retention/retire.js');

const reportedNames = (): string[] => (mockBuildReport.mock.calls.at(-1)![0] as { plans: Array<{ name: string }> }).plans.map((p) => p.name);

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  failName = null;
  mockPlanPlugin.mockClear();
  mockBuildReport.mockClear();
  mockIncCounter.mockClear();
});

describe('planning concurrency', () => {
  it('plans more than one plugin at a time, never more than the cap', async () => {
    expect(RETENTION_PLAN_CONCURRENCY).toBeGreaterThan(1);
    await runRetentionPass({ dryRun: true });
    expect(mockPlanPlugin).toHaveBeenCalledTimes(NAMES.length);
    expect(maxInFlight).toBe(RETENTION_PLAN_CONCURRENCY);
  });

  it('reports the plans in catalogue order even when later plugins finish first', async () => {
    await runRetentionPass({ dryRun: true });
    expect(reportedNames()).toEqual(NAMES);
  });

  it('skips and counts a plugin whose plan fails, and still plans the rest', async () => {
    failName = NAMES[3]!;
    await runRetentionPass({ dryRun: true });
    expect(reportedNames()).toEqual(NAMES.filter((n) => n !== failName));
    expect(mockIncCounter).toHaveBeenCalledWith(expect.any(String), { stage: 'select' });
  });

  it('starts no new plans once the scheduler lease is lost', async () => {
    const controller = new AbortController();
    controller.abort();
    await runRetentionPass({ dryRun: true, signal: controller.signal });
    expect(mockPlanPlugin).not.toHaveBeenCalled();
  });
});
