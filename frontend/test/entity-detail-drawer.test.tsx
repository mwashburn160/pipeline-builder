// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `EntityDetailDrawer` is the one fetch → error-with-retry → spinner → list
 * ceremony the discount, promotion and service-account drawers each carried
 * their own copy of. These pin the three branches and the retry.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EntityDetailDrawer } from '../src/components/ui/EntityDetailDrawer';

type Thing = { id: string; name: string };

function renderDrawer(fetch: (signal: AbortSignal) => Promise<Thing | null>, extra = false) {
  return render(
    <EntityDetailDrawer<Thing>
      fetch={fetch}
      deps={['t1']}
      ariaLabel="Thing details"
      fallbackTitle="Thing"
      title={(t) => t.name}
      subtitle={(t) => <span>id {t.id}</span>}
      items={(t) => [{ label: 'ID', value: t.id }]}
      errorMessage="Failed to load thing"
      loadingLabel="Loading thing"
      onClose={() => {}}
      {...(extra ? { children: (t: Thing) => <p>extra for {t.name}</p> } : {})}
    />,
  );
}

describe('EntityDetailDrawer', () => {
  it('shows the fallback title and a labelled spinner while loading', async () => {
    let release: (v: Thing) => void = () => {};
    renderDrawer(() => new Promise<Thing>((res) => { release = res; }));
    expect(screen.getByRole('heading', { name: 'Thing' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading thing' })).toBeInTheDocument();
    release({ id: 't1', name: 'Widget' });
    await screen.findByRole('heading', { name: 'Widget' });
  });

  it('renders the entity title, subtitle and items once loaded', async () => {
    renderDrawer(async () => ({ id: 't1', name: 'Widget' }));
    expect(await screen.findByRole('heading', { name: 'Widget' })).toBeInTheDocument();
    expect(screen.getByText('id t1')).toBeInTheDocument();
    expect(screen.getByText('ID')).toBeInTheDocument();
  });

  it('renders extra sections below the list when children are given', async () => {
    renderDrawer(async () => ({ id: 't1', name: 'Widget' }), true);
    expect(await screen.findByText('extra for Widget')).toBeInTheDocument();
  });

  it('surfaces a failed fetch with a retry that reloads', async () => {
    let attempt = 0;
    renderDrawer(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('nope');
      return { id: 't1', name: 'Widget' };
    });
    // The thrown message wins; `errorMessage` is only the fallback.
    expect(await screen.findByText('nope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Widget' })).toBeInTheDocument());
  });

  it('falls back to the supplied message when the failure carries none', async () => {
    renderDrawer(async () => { throw new Error(''); });
    expect(await screen.findByText('Failed to load thing')).toBeInTheDocument();
  });
});
