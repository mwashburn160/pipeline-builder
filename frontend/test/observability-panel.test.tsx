// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for Panel. The wrapper handles three states the inner viz
 * components rely on — loading skeleton, error banner, "no data" message —
 * so this is the contract test for that state machine.
 */

import { render, screen } from '@testing-library/react';
import { Panel } from '../src/components/observability/Panel';

describe('Panel', () => {
  it('renders a loading skeleton when loading=true', () => {
    render(
      <Panel title="Test Panel" loading={true} error={null} empty={false}>
        <div>children</div>
      </Panel>,
    );
    expect(screen.getByText('Test Panel')).toBeInTheDocument();
    // Children are not rendered while loading
    expect(screen.queryByText('children')).not.toBeInTheDocument();
  });

  it('renders the error banner with the error message', () => {
    render(
      <Panel title="Test Panel" loading={false} error={new Error('boom')} empty={false}>
        <div>children</div>
      </Panel>,
    );
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.queryByText('children')).not.toBeInTheDocument();
  });

  it('renders "No data" when empty=true (success-with-empty path)', () => {
    render(
      <Panel title="Test Panel" loading={false} error={null} empty={true}>
        <div>children</div>
      </Panel>,
    );
    expect(screen.getByText('No data in this range')).toBeInTheDocument();
    expect(screen.queryByText('children')).not.toBeInTheDocument();
  });

  it('renders children when the panel is happy (not loading / not error / not empty)', () => {
    render(
      <Panel title="Test Panel" loading={false} error={null} empty={false}>
        <div>actual content</div>
      </Panel>,
    );
    expect(screen.getByText('actual content')).toBeInTheDocument();
  });

  it('error takes precedence over loading', () => {
    // If both flags are set, error wins (don't show skeleton over a real error)
    render(
      <Panel title="Test Panel" loading={true} error={new Error('failed')} empty={false}>
        <div>children</div>
      </Panel>,
    );
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });
});
