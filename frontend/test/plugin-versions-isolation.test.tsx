// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Isolation tests for the extracted PluginVersions tab: the loading skeleton,
 * the no-data empty state, the version table, and the stale-default warning
 * banner shown when a plugin lacks a default version.
 */

import { render, screen } from '@testing-library/react';
import { PluginVersions } from '../src/components/reports/PluginVersions';
import type { PluginVersion } from '../src/components/reports/types';

const withDefault: PluginVersion = { name: 'alpha', version_count: 3, latest_version: '1.2.0', has_default: true };
const stale: PluginVersion = { name: 'beta', version_count: 2, latest_version: '0.9.0', has_default: false };

describe('PluginVersions (isolation)', () => {
  it('renders the skeleton while loading with no data', () => {
    const { container } = render(<PluginVersions loading pluginVersions={[]} />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders the empty state when not loading and no data', () => {
    render(<PluginVersions loading={false} pluginVersions={[]} />);
    expect(screen.getByText('No version data yet')).toBeInTheDocument();
  });

  it('renders the version table with data (no stale banner when all have defaults)', () => {
    render(<PluginVersions loading={false} pluginVersions={[withDefault]} />);
    expect(screen.getByText('Plugin Versions')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText(/without a default version/i)).not.toBeInTheDocument();
  });

  it('surfaces the stale-default warning for plugins missing a default version', () => {
    render(<PluginVersions loading={false} pluginVersions={[withDefault, stale]} />);
    expect(screen.getByText(/1 plugin without a default version/i)).toBeInTheDocument();
    expect(screen.getByText('beta', { selector: 'p' })).toBeInTheDocument();
  });
});
