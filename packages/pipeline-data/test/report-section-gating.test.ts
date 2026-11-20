// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stakeholder section gating parity with the dashboard routes.
 *
 * The `/environments` dashboard route and the promotion view (insights) are
 * gated on `advanced_reporting`, but their stakeholder sections were ungated, so
 * a report handed an org without the entitlement the very data the dashboard
 * withholds. They now declare `requiresFeature` the way the DORA sections do.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { composeSnapshot } from '../src/api/reporting/stakeholder/compose.js';
import { resolvePeriod } from '../src/api/reporting/stakeholder/period.js';
import { getReportSection } from '../src/api/reporting/stakeholder/sections.js';
import type { SectionDataSource } from '../src/api/reporting/stakeholder/sections.js';

const PERIOD = resolvePeriod('weekly', 'UTC', 'monday', new Date('2026-09-23T12:00:00Z'));

function source(): SectionDataSource {
  return new Proxy({}, { get: () => jest.fn(async () => ({})) }) as unknown as SectionDataSource;
}

function opts(features: string[], src = source()) {
  return {
    source: src,
    period: PERIOD,
    timezone: 'UTC',
    weekStart: 'monday' as const,
    orgId: 'org-1',
    features,
    now: new Date('2026-09-23T12:00:00Z'),
  };
}

describe.each(['environments', 'promotion'])('the %s section', (id) => {
  it('declares advanced_reporting, like the DORA sections', () => {
    expect(getReportSection(id)?.requiresFeature).toBe('advanced_reporting');
    expect(getReportSection(id)?.requiresFeature).toBe(getReportSection('dora')?.requiresFeature);
  });

  it('renders LOCKED without the feature, and never reads its data', async () => {
    const src = source();
    const snap = await composeSnapshot([id, 'success_rate'], opts(['sso'], src));
    const section = snap.sections.find((s) => s.id === id)!;
    expect(section.state).toBe('locked');
    expect(section.requiresFeature).toBe('advanced_reporting');
    expect(section.current).toBeUndefined();
    expect(snap.notes.some((n) => n.code === 'section_locked' && n.sectionId === id)).toBe(true);
    // The rest of the report still delivers.
    expect(snap.sections.find((s) => s.id === 'success_rate')!.state).toBe('ok');
  });

  it('runs with advanced_reporting (or the stakeholder_reports substitute)', async () => {
    for (const features of [['advanced_reporting'], ['stakeholder_reports']]) {
      const snap = await composeSnapshot([id], opts(features));
      expect(snap.sections[0]?.state).toBe('ok');
    }
  });
});
