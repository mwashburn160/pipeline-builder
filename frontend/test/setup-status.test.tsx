// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Setup progress: "Done" on the popup proves nothing, so the guide reads what
 * the platform can actually see — the keys `store-token` issues and the event
 * forwarder's heartbeat. A row the viewer may not read must say "unknown", never
 * "not done", or an admin without one permission is told to redo finished work.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import { keyStatus } from '../src/lib/setup-guide';

const future = new Date(Date.now() + 10 * 86400_000).toISOString();

describe('keyStatus', () => {
  const acct = (over: Partial<{ name: string; disabled: boolean; keys: Array<{ status: string; expiresAt: string; lastUsedAt: string | null }> }> = {}) => ({
    name: 'reporting-ingest', disabled: false, keys: [{ status: 'active', expiresAt: future, lastUsedAt: null }], ...over,
  });

  it('unknown — not missing — when the account list could not be read', () => {
    expect(keyStatus(null, 'reporting-ingest').state).toBe('unknown');
  });
  it('missing when store-token never created the account', () => {
    expect(keyStatus([acct({ name: 'platform-automation' })], 'reporting-ingest').state).toBe('missing');
  });
  it('done with an active key', () => {
    expect(keyStatus([acct()], 'reporting-ingest')).toEqual({ state: 'done', detail: `Active key, expires ${future.slice(0, 10)}.` });
  });
  it('attention when every key expired or was revoked', () => {
    const s = keyStatus([acct({ keys: [{ status: 'expired', expiresAt: future, lastUsedAt: null }, { status: 'revoked', expiresAt: future, lastUsedAt: null }] })], 'reporting-ingest');
    expect(s.state).toBe('attention');
  });
  it('attention when the account is disabled, even with an active key', () => {
    expect(keyStatus([acct({ disabled: true })], 'reporting-ingest').state).toBe('attention');
  });
});

// --- the panel -------------------------------------------------------------

let mockPermissions: string[] = [];
const listServiceAccounts = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const getIngestHealth = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/api', () => ({ __esModule: true, default: { listServiceAccounts: (...a: unknown[]) => listServiceAccounts(...a), getIngestHealth: (...a: unknown[]) => getIngestHealth(...a) } }));

import { SetupStatusPanel } from '../src/components/onboarding/SetupStatusPanel';

function rowState(label: RegExp): string | null {
  return screen.getByText(label).closest('li')!.getAttribute('data-state');
}

beforeEach(() => {
  listServiceAccounts.mockReset();
  getIngestHealth.mockReset();
});

describe('SetupStatusPanel', () => {
  it('without the permissions, reads nothing and reports every row unknown', () => {
    mockPermissions = [];
    render(<SetupStatusPanel orgId="org-1" user={{ id: 'u1', permissions: mockPermissions } as never} showEvents />);
    expect(listServiceAccounts).not.toHaveBeenCalled();
    expect(getIngestHealth).not.toHaveBeenCalled();
    expect(rowState(/Platform token stored/)).toBe('unknown');
    expect(rowState(/Reporting-ingest token stored/)).toBe('unknown');
    expect(rowState(/Pipeline events received/)).toBe('unknown');
  });

  it('a platform key alone is not enough: ingest token missing, no events', async () => {
    mockPermissions = ['service_accounts:manage', 'reports:read'];
    listServiceAccounts.mockResolvedValue({ data: { serviceAccounts: [
      { name: 'platform-automation', disabled: false, keys: [{ status: 'active', expiresAt: future, lastUsedAt: null }] },
    ] } });
    getIngestHealth.mockResolvedValue({ health: null, now: new Date().toISOString() });
    render(<SetupStatusPanel orgId="org-1" user={{ id: 'u1', permissions: mockPermissions } as never} showEvents />);
    await waitFor(() => expect(rowState(/Platform token stored/)).toBe('done'));
    expect(rowState(/Reporting-ingest token stored/)).toBe('missing');
    await waitFor(() => expect(rowState(/Pipeline events received/)).toBe('missing'));
  });

  it('events flowing shows done', async () => {
    mockPermissions = ['reports:read'];
    const now = new Date().toISOString();
    getIngestHealth.mockResolvedValue({ health: { updatedAt: now, lastEventAt: now, forwarded: 3, dropped: 0 }, now });
    render(<SetupStatusPanel orgId="org-1" user={{ id: 'u1', permissions: mockPermissions } as never} showEvents />);
    await waitFor(() => expect(rowState(/Pipeline events received/)).toBe('done'));
  });

  it('dropped events need attention', async () => {
    mockPermissions = ['reports:read'];
    const now = new Date().toISOString();
    getIngestHealth.mockResolvedValue({ health: { updatedAt: now, lastEventAt: now, forwarded: 3, dropped: 2 }, now });
    render(<SetupStatusPanel orgId="org-1" user={{ id: 'u1', permissions: mockPermissions } as never} showEvents />);
    await waitFor(() => expect(rowState(/Pipeline events received/)).toBe('attention'));
    expect(screen.getByText(/2 dropped events/)).toBeInTheDocument();
  });

  it('renders nothing off AWS (there is no event infra to check)', () => {
    mockPermissions = ['service_accounts:manage', 'reports:read'];
    const { container } = render(<SetupStatusPanel orgId="org-1" user={{ id: 'u1', permissions: mockPermissions } as never} showEvents={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(listServiceAccounts).not.toHaveBeenCalled();
  });
});
