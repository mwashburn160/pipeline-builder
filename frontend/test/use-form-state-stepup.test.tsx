// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useFormState.run` must follow a step-up refusal the global dialog took over.
 *
 * Every write goes out with the step-up resume offered (`replayOnStepUp` is the
 * default), so an org-settings save on a step-up-gated route used to put a red
 * error UNDER the confirmation dialog, and then — once the person confirmed and
 * the replay landed server-side — leave the error there and never refresh.
 * `useDelete` already followed the replay; this pins that `run` does too.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook } from '@testing-library/react';
import { useFormState } from '../src/hooks/useFormState';
import { StepUpRequiredError } from '../src/lib/api/errors';

/** A refusal the global dialog has claimed, with its replay still pending. */
function claimedRefusal() {
  const err = new StepUpRequiredError('Confirm it is you', 'STEP_UP_REQUIRED');
  let settle!: (v: unknown) => void;
  let reject!: (r: unknown) => void;
  err.attachResume(new Promise((res, rej) => { settle = res; reject = rej; }));
  return { err, confirm: settle, dismiss: reject };
}

describe('useFormState.run and the step-up replay', () => {
  it('shows NO error while the dialog is up, then finishes when the replay lands', async () => {
    const { err, confirm } = claimedRefusal();
    const onSuccess = jest.fn<AnyFn>();
    const { result } = renderHook(() => useFormState());

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.run(() => Promise.reject(err), {
        successMessage: 'Organization updated',
        onSuccess: onSuccess as (r: unknown) => void,
      });
    });

    // Claimed: the dialog owns the outcome, so the form stays quiet — and the
    // spinner stops, because the person now has a dialog to answer.
    expect(returned).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.success).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      confirm({ success: true, data: { organization: { name: 'Acme' } } });
      await Promise.resolve();
    });

    expect(onSuccess).toHaveBeenCalledWith({ success: true, data: { organization: { name: 'Acme' } } });
    expect(result.current.success).toBe('Organization updated');
    expect(result.current.error).toBeNull();
  });

  it('reports the refusal once the person dismisses the dialog', async () => {
    const { err, dismiss } = claimedRefusal();
    const onSuccess = jest.fn<AnyFn>();
    const { result } = renderHook(() => useFormState());

    await act(async () => {
      await result.current.run(() => Promise.reject(err), { onSuccess: onSuccess as (r: unknown) => void });
    });
    expect(result.current.error).toBeNull();

    await act(async () => {
      dismiss(err);
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Confirm it is you');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('an UNCLAIMED refusal (no dialog mounted) still surfaces as a form error', async () => {
    const err = new StepUpRequiredError('Confirm it is you', 'STEP_UP_REQUIRED');
    const { result } = renderHook(() => useFormState());

    await act(async () => { await result.current.run(() => Promise.reject(err)); });

    expect(result.current.error).toBe('Confirm it is you');
    expect(result.current.loading).toBe(false);
  });

  it('runs onSuccess with the result and the success message on the ordinary path', async () => {
    const onSuccess = jest.fn<AnyFn>();
    const { result } = renderHook(() => useFormState());

    let returned: unknown;
    await act(async () => {
      returned = await result.current.run(() => Promise.resolve({ id: 'r1' }), {
        successMessage: 'Saved',
        onSuccess: onSuccess as (r: unknown) => void,
      });
    });

    expect(returned).toEqual({ id: 'r1' });
    expect(onSuccess).toHaveBeenCalledWith({ id: 'r1' });
    expect(result.current.success).toBe('Saved');
  });

  it('a throw from onSuccess is a render bug, not a failed write — it is not shown as a form error', async () => {
    const { result } = renderHook(() => useFormState());

    await expect(act(async () => {
      await result.current.run(() => Promise.resolve('ok'), {
        successMessage: 'Saved',
        onSuccess: () => { throw new Error('bad side effect'); },
      });
    })).rejects.toThrow('bad side effect');

    expect(result.current.error).toBeNull();
  });
});
