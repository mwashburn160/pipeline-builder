// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Log export is a raw `fetch` (the body is a file), so it bypasses the client's
 * error handling. When the org's "administrative actions require MFA" policy
 * refuses it, the refusal must still reach the shell's MFA dialog — not end as
 * a bare "Log export failed".
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { observabilityApi } from '../src/lib/api/domains/observability';
import { MfaRequiredError } from '../src/lib/api/errors';

const core = {
  ensureFreshToken: jest.fn<AnyFn>(async () => undefined),
  authHeaders: jest.fn<AnyFn>(() => ({ Authorization: 'Bearer t' })),
} as unknown as ApiCore;

function respond(status: number, body: unknown) {
  global.fetch = jest.fn<AnyFn>(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
    headers: new Headers(),
    blob: async () => new Blob(['x']),
  })) as unknown as typeof fetch;
}

describe('logExport — MFA refusal', () => {
  it('raises MfaRequiredError and dispatches the shell\'s mfa-required event', async () => {
    respond(401, { code: 'MFA_REQUIRED', message: 'Your organization requires two-factor authentication for administrative actions' });
    const seen: Array<{ code?: string; message?: string }> = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('mfa-required', listener);

    await expect(observabilityApi(core).logExport({ window: { kind: 'preset', key: '1h' } } as never)).rejects.toBeInstanceOf(MfaRequiredError);
    expect(seen).toEqual([expect.objectContaining({ code: 'MFA_REQUIRED', message: expect.stringMatching(/administrative actions/) })]);
    window.removeEventListener('mfa-required', listener);
  });

  it('keeps an ordinary failure an ordinary error, with the server\'s wording', async () => {
    respond(403, { message: 'Forbidden' });
    await expect(observabilityApi(core).logExport({ window: { kind: 'preset', key: '1h' } } as never)).rejects.toThrow('Forbidden');
  });
});
