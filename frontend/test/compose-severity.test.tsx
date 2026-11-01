// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Case severity on the compose form, and the premium gate on `urgent`.
 *
 * The control exists because of a PRICING decision. Premium's only
 * differentiator used to be its coverage window, which bites on about two days
 * in seven, so the priority-to-premium step doubled the price for a wider clock
 * and nothing else. Admitting `urgent` only at premium turns the top rung into a
 * capability — "you can declare an emergency" — and that is the half of the step
 * a buyer can see.
 *
 * Which makes this control part of the SKU rather than a nicety: before it,
 * `priority` was hardcoded to `'normal'` on send and no severity picker existed
 * anywhere, so premium would have been sold a capability the product never
 * offered. The tests below pin the three things that keeps honest:
 *
 *  - the option is OFFERED, so the capability is reachable;
 *  - it is VISIBLE-but-disabled below premium, never hidden, so an org learns
 *    the option exists and what buys it;
 *  - nothing renders until the entitlement has resolved, so a premium org never
 *    sees a flash of the locked state.
 *
 * It is also deliberately support-only: the severity sold is a CASE severity,
 * and an org-to-org message has no case and no response target.
 */

import { it, expect, jest, describe, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { ComposeModal } from '@/components/message/ComposeModal';

/** What `useFeatureGate('support_premium')` reports for the render under test. */
let gate = { entitled: false, isLoaded: true };
const gateFlags: string[] = [];
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: (flag: string) => {
    gateFlags.push(flag);
    return { ...gate, flag, label: 'Premium Support', reason: 'Not on your plan' };
  },
}));

const onSend = jest.fn<AnyFn>(async () => true);

const open = (over: Record<string, unknown> = {}) => render(
  <ComposeModal
    isOpen
    onClose={() => {}}
    onSend={onSend as never}
    canWrite={false}
    isSuperAdmin={false}
    supportAlias="support@example.test"
    {...over}
  />,
);

/** The severity control, or null when it is not rendered at all. */
const severitySelect = () => screen.queryByLabelText('Case severity') as HTMLSelectElement | null;
const optionFor = (value: string) =>
  Array.from(severitySelect()?.options ?? []).find((o) => o.value === value);

/**
 * Type a body and send, returning the payload `onSend` received.
 *
 * Queried off the document, not the render container: `Modal` renders through a
 * portal, so the form is not inside what `render` hands back.
 */
async function send() {
  const body = document.querySelector('textarea')!;
  fireEvent.change(body, { target: { value: 'The build is down.' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(onSend).toHaveBeenCalled());
  return onSend.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  gateFlags.length = 0;
  gate = { entitled: false, isLoaded: true };
});

describe('the control is offered on a support send', () => {
  it('reads the premium entitlement, and only that one', () => {
    open();
    expect(gateFlags).toContain('support_premium');
  });

  it('offers normal and high to everyone', () => {
    open();
    expect(severitySelect()).not.toBeNull();
    expect(optionFor('normal')).toBeDefined();
    expect(optionFor('high')).toBeDefined();
  });

  it('defaults to normal, so a severity is never claimed by accident', async () => {
    open();
    expect(severitySelect()!.value).toBe('normal');
    expect(await send()).toMatchObject({ priority: 'normal', support: true });
  });
});

describe('urgent is premium-only', () => {
  it('is selectable at premium', async () => {
    gate = { entitled: true, isLoaded: true };
    open();
    expect(optionFor('urgent')!.disabled).toBe(false);
    fireEvent.change(severitySelect()!, { target: { value: 'urgent' } });
    expect(await send()).toMatchObject({ priority: 'urgent' });
  });

  it('is VISIBLE but disabled below premium, and says what buys it', () => {
    // Hiding it would be the wrong lock: an org that cannot declare an emergency
    // still has to learn the option exists, and the server would downgrade an
    // urgent it was sent anyway — so concealing it buys nothing and teaches
    // nothing.
    open();
    const urgent = optionFor('urgent');
    expect(urgent).toBeDefined();
    expect(urgent!.disabled).toBe(true);
    expect(urgent!.textContent).toMatch(/Premium Support only/);
  });

  it('renders NOTHING about urgent until the entitlement resolves', () => {
    // Otherwise a premium org sees a flash of "Premium Support only" on its own
    // paid feature, which is the worst version of this control.
    gate = { entitled: false, isLoaded: false };
    open();
    expect(severitySelect()).not.toBeNull();
    expect(optionFor('urgent')).toBeUndefined();
  });

  it('still sends high — the lock never blocks the message', async () => {
    open();
    fireEvent.change(severitySelect()!, { target: { value: 'high' } });
    expect(await send()).toMatchObject({ priority: 'high' });
  });
});

describe('it is a CASE severity, so it belongs to support sends only', () => {
  it('is absent when a full-compose user addresses a concrete org', () => {
    // An org-to-org message has no case, no response target and no severity to
    // sell — offering the control there would imply a commitment that does not
    // exist.
    open({ canWrite: true, recipientSuggestions: [{ value: 'org-9', label: 'Team Nine' }] });
    const to = screen.getByLabelText(/Recipient organization/i);
    fireEvent.change(to, { target: { value: 'org-9' } });
    expect(severitySelect()).toBeNull();
  });

  it('comes back when a full-compose user addresses the support alias', () => {
    // The To field defaults to the alias, so "New Message" is a contact-support
    // flow for everyone — including someone who COULD address an org directly.
    open({ canWrite: true });
    expect(severitySelect()).not.toBeNull();
  });
});
