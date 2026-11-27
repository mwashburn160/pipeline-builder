// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grouped page tabs: `?tab=<tab>&section=<sub>` names a tab and, for a tab that
 * has them, a sub-tab. Only those keys are read; any other `?tab=` value falls
 * to the page's default tab, and a section the tab does not hold to its first
 * sub-tab.
 */
import { describe, it, expect } from '@jest/globals';
import { resolveTabLocation, settleTabLocation, tabQuery, type GroupedTabsConfig } from '../src/lib/page-tabs/grouped';
import { resolvePluginsTab } from '../src/lib/page-tabs/plugins';
import { resolveReportsTab, reportAt } from '../src/lib/page-tabs/reports';
import { resolveEcosystemTab } from '../src/lib/page-tabs/ecosystem';
import { resolvePublisherTab } from '../src/lib/page-tabs/publisher';
import { resolveToolchainTab } from '../src/lib/page-tabs/toolchain';

describe('Plugins', () => {
  it.each([
    ['mine', undefined, 'mine', null],
    ['catalog', undefined, 'catalog', null],
    ['installs', undefined, 'installs', null],
    ['security', 'vulnerabilities', 'security', 'vulnerabilities'],
    ['security', 'remediations', 'security', 'remediations'],
    ['security', 'policy', 'security', 'policy'],
    ['security', 'approvals', 'security', 'approvals'],
    ['builds', undefined, 'builds', null],
  ])('?tab=%s&section=%s lands on %s / %s', (tab, section, expectedTab, expectedSection) => {
    expect(resolvePluginsTab(tab, section)).toEqual({ tab: expectedTab, section: expectedSection });
  });

  it('ignores a section the tab does not have, and falls to the default for an unknown tab', () => {
    expect(resolvePluginsTab('security', 'bogus')).toEqual({ tab: 'security', section: null });
    expect(resolvePluginsTab('catalog', 'policy')).toEqual({ tab: 'catalog', section: null });
    expect(resolvePluginsTab(undefined, undefined)).toEqual({ tab: 'mine', section: null });
    expect(resolvePluginsTab('bogus', 'policy')).toEqual({ tab: 'mine', section: null });
  });

  it.each(['remediations', 'policy', 'approvals', 'vulnerabilities', 'failed'])('a sub-tab id is not a tab: ?tab=%s opens the default', (key) => {
    expect(resolvePluginsTab(key, undefined)).toEqual({ tab: 'mine', section: null });
  });
});

describe('Reports', () => {
  it.each([
    ['overview', 'pipelines', 'pipelines'],
    ['overview', 'plugins', 'plugins'],
    ['overview', 'teams', 'teams'],
    ['delivery', 'delivery', 'delivery'],
    ['delivery', 'dora', 'dora'],
    ['delivery', 'flow', 'flow'],
    ['quality', 'scorecard', 'scorecard'],
    ['quality', 'insights', 'insights'],
    ['security', undefined, 'security'],
    ['stakeholder', undefined, 'stakeholder'],
  ])('?tab=%s&section=%s shows the %s report', (tab, section, report) => {
    expect(reportAt(resolveReportsTab(tab, section))).toBe(report);
  });

  it('opens a tab on its first report when no section is named', () => {
    expect(reportAt(resolveReportsTab('delivery', undefined))).toBe('delivery');
    expect(reportAt(resolveReportsTab('quality', undefined))).toBe('scorecard');
  });

  it.each(['pipelines', 'plugins', 'teams', 'dora', 'flow', 'scorecard', 'insights', 'bogus', undefined])('?tab=%s lands on the pipelines report', (key) => {
    expect(resolveReportsTab(key, undefined)).toEqual({ tab: 'overview', section: null });
    expect(reportAt(resolveReportsTab(key, undefined))).toBe('pipelines');
  });
});

describe('Ecosystem', () => {
  it.each([
    ['publishing', 'queue'], ['publishing', 'publishers'], ['publishing', 'rules'],
    ['listings', 'listings'], ['listings', 'reviews'], ['listings', 'reserved'],
    ['security', 'advisories'], ['security', 'vulnerabilities'],
    ['storage', 'kept-images'], ['storage', 'retention'],
  ])('?tab=%s&section=%s', (tab, section) => {
    expect(resolveEcosystemTab(tab, section)).toEqual({ tab, section });
  });

  it.each(['queue', 'publishers', 'rules', 'reviews', 'reserved', 'advisories', 'vulnerabilities', 'kept-images', 'retention'])(
    'a sub-tab id is not a tab: ?tab=%s opens the default',
    (key) => { expect(resolveEcosystemTab(key, undefined)).toEqual({ tab: 'publishing', section: null }); },
  );

  it('reads managers, which has no sub-tabs', () => {
    expect(resolveEcosystemTab('managers', undefined)).toEqual({ tab: 'managers', section: null });
  });
});

describe('Publisher', () => {
  it.each([
    ['profile', undefined, null], ['listings', 'listings', 'listings'], ['listings', 'insights', 'insights'],
    ['requests', 'requests', 'requests'], ['requests', 'publish', 'publish'],
    ['security', 'advisories', 'advisories'], ['security', 'fixes', 'fixes'],
  ])('?tab=%s&section=%s', (tab, section, expected) => {
    expect(resolvePublisherTab(tab, section)).toEqual({ tab, section: expected });
  });

  it.each(['insights', 'publish', 'advisories', 'fixes'])('a sub-tab id is not a tab: ?tab=%s opens the default', (key) => {
    expect(resolvePublisherTab(key, undefined)).toEqual({ tab: 'profile', section: null });
  });
});

describe('Toolchain', () => {
  it.each([
    ['releases', undefined, null], ['rollout', 'canary', 'canary'], ['rollout', 'adoption', 'adoption'],
    ['rollout', 'affected', 'affected'], ['history', undefined, null], ['cleanup', undefined, null],
  ])('?tab=%s&section=%s', (tab, section, expected) => {
    expect(resolveToolchainTab(tab, section)).toEqual({ tab, section: expected });
  });

  it.each(['canary', 'adoption', 'affected'])('a sub-tab id is not a tab: ?tab=%s opens the default', (key) => {
    expect(resolveToolchainTab(key, undefined)).toEqual({ tab: 'releases', section: null });
  });
});

describe('the shared resolver', () => {
  const config: GroupedTabsConfig<'a' | 'b', 'x' | 'y'> = {
    groups: { a: [], b: ['x', 'y'] },
    defaultTab: 'a',
  };

  it('reads only tab ids, falling to the default otherwise', () => {
    expect(resolveTabLocation(config, 'b', 'y')).toEqual({ tab: 'b', section: 'y' });
    expect(resolveTabLocation(config, 'y', undefined)).toEqual({ tab: 'a', section: null });
  });

  it('settles on the first visible tab and sub-tab', () => {
    expect(settleTabLocation(config, { tab: 'b', section: null })).toEqual({ tab: 'b', section: 'x' });
    expect(settleTabLocation(config, { tab: 'b', section: 'x' }, { sections: () => ['y'] })).toEqual({ tab: 'b', section: 'y' });
    expect(settleTabLocation(config, { tab: 'b', section: 'y' }, { tabs: ['a'] })).toEqual({ tab: 'a', section: null });
  });

  it('writes a section only for a tab that has one', () => {
    expect(tabQuery({ tab: 'b', section: 'y' })).toEqual({ tab: 'b', section: 'y' });
    expect(tabQuery({ tab: 'a', section: null })).toEqual({ tab: 'a' });
  });
});
