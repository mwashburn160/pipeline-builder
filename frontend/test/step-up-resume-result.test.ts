// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The global step-up replay's RESULT reaches the code that made the call.
 *
 * The dashboard shell used to replay a refused request and keep the outcome to
 * itself: the write happened, but the page that asked for it had already shown
 * a failure and never refreshed — and for a call that returns a one-time
 * secret (an access key, recovery codes) the secret was minted and shown to
 * nobody. Pinned here:
 *   - a claimed refusal carries `resume`, which settles with the replay;
 *   - `withStepUpResume` / `continueAfterStepUp` follow it (through a second
 *     refusal too), and a dismissed dialog rejects it;
 *   - an unclaimed refusal (no dialog mounted) carries nothing to wait for;
 *   - secret-returning and ceremony-starting calls are never offered for replay.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore } from '../src/lib/api/core';
import { StepUpRequiredError, withStepUpResume, continueAfterStepUp } from '../src/lib/api/errors';

type Detail = { retry?: (t: string) => Promise<unknown>; cancel?: () => void };

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

/** `refusals` step-up 401s, then a success carrying `payload`. */
function mockFetch(refusals: number, payload: unknown = { success: true, data: { ok: true } }) {
  let n = 0;
  const fetchMock = jest.fn<AnyFn>(() => {
    n += 1;
    const refused = n <= refusals;
    return Promise.resolve({
      status: refused ? 401 : 200,
      ok: !refused,
      json: async () => (refused ? { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' } : payload),
    } as unknown as Response);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Stand in for the dashboard shell: claim every refusal, collect its detail. */
function claimRefusals() {
  const seen: Detail[] = [];
  const listener = (e: Event) => { e.preventDefault(); seen.push((e as CustomEvent).detail as Detail); };
  window.addEventListener('step-up-required', listener);
  return { seen, stop: () => window.removeEventListener('step-up-required', listener) };
}

describe('the refused call gets the replay back', () => {
  it('withStepUpResume resolves with the REPLAY result once the dialog confirms', async () => {
    mockFetch(1, { success: true, data: { subscription: { status: 'canceled' } } });
    const core = new ApiCore();
    const { seen, stop } = claimRefusals();

    const pending = withStepUpResume(() => core.request('/api/billing/subscriptions/s1/cancel', { method: 'POST' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    await seen[0].retry!('fresh');
    await expect(pending).resolves.toEqual({ success: true, data: { subscription: { status: 'canceled' } } });
    stop();
  });

  it('follows a SECOND refusal through to the replay that finally lands', async () => {
    mockFetch(2);
    const core = new ApiCore();
    const { seen, stop } = claimRefusals();

    const pending = withStepUpResume(() => core.request('/api/x', { method: 'DELETE' }));
    await new Promise((r) => setTimeout(r, 0));
    await expect(seen[0].retry!('stale')).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(seen).toHaveLength(2);
    await seen[1].retry!('fresh');
    await expect(pending).resolves.toEqual({ success: true, data: { ok: true } });
    stop();
  });

  it('continueAfterStepUp claims the refusal and refreshes after the replay', async () => {
    mockFetch(1);
    const core = new ApiCore();
    const { seen, stop } = claimRefusals();
    const refreshed = jest.fn<AnyFn>();

    let handled = false;
    try { await core.request('/api/x', { method: 'DELETE' }); } catch (err) { handled = continueAfterStepUp(err, refreshed); }
    expect(handled).toBe(true);
    expect(refreshed).not.toHaveBeenCalled();

    await seen[0].retry!('fresh');
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshed).toHaveBeenCalledWith({ success: true, data: { ok: true } });
    stop();
  });

  it('a dismissed dialog rejects the resume with the original refusal', async () => {
    mockFetch(1);
    const core = new ApiCore();
    const { seen, stop } = claimRefusals();

    const pending = withStepUpResume(() => core.request('/api/x', { method: 'DELETE' }));
    await new Promise((r) => setTimeout(r, 0));
    seen[0].cancel!();
    await expect(pending).rejects.toBeInstanceOf(StepUpRequiredError);
    stop();
  });

  it('an UNCLAIMED refusal has nothing to wait for — the caller handles it as before', async () => {
    mockFetch(1);
    const core = new ApiCore();
    const err = await core.request('/api/x', { method: 'DELETE' }).catch((e) => e);
    expect(err).toBeInstanceOf(StepUpRequiredError);
    expect((err as StepUpRequiredError).resume).toBeUndefined();
    expect(continueAfterStepUp(err, jest.fn<AnyFn>())).toBe(false);
  });
});

describe('calls whose result is a one-time secret or a ceremony are never replayed', () => {
  it('replayOnStepUp:false dispatches nothing and carries no resume', async () => {
    const fetchMock = mockFetch(1);
    const core = new ApiCore();
    const { seen, stop } = claimRefusals();

    const err = await core.request('/api/user/keys', { method: 'POST', replayOnStepUp: false }).catch((e) => e);
    stop();
    expect(err).toBeInstanceOf(StepUpRequiredError);
    expect(seen).toHaveLength(0);
    expect((err as StepUpRequiredError).resume).toBeUndefined();
    // The knob is the client's own: it never reaches fetch.
    expect((fetchMock.mock.calls[0][1] as Record<string, unknown>).replayOnStepUp).toBeUndefined();
  });

  it.each([
    ['createAccessKey', (api: Record<string, AnyFn>) => api.createAccessKey({ name: 'k' }, 't')],
    ['createServiceAccountKey', (api: Record<string, AnyFn>) => api.createServiceAccountKey('o', 'a', { name: 'k' }, 't')],
    ['regenerateRecoveryCodes', (api: Record<string, AnyFn>) => api.regenerateRecoveryCodes('t')],
    ['enrolTotp', (api: Record<string, AnyFn>) => api.enrolTotp('t')],
    ['getPasskeyRegistrationOptions', (api: Record<string, AnyFn>) => api.getPasskeyRegistrationOptions('t')],
  ])('%s is marked non-replayable', async (_name, call) => {
    mockFetch(1);
    const { api } = await import('../src/lib/api');
    const { seen, stop } = claimRefusals();
    await expect(call(api as unknown as Record<string, AnyFn>)).rejects.toBeInstanceOf(StepUpRequiredError);
    stop();
    expect(seen).toHaveLength(0);
  });
});
