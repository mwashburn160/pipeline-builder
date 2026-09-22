// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File / text endpoints (log export, the namespace YAML, …) return a body that
 * is not the JSON envelope, but their failures must still go through the
 * client's shared handling: an MFA refusal reaches the shell's MFA dialog, a
 * step-up refusal is a StepUpRequiredError the step-up dialog can resume —
 * never a bare "Log export failed" / "Failed to fetch namespace YAML: 401".
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore } from '../src/lib/api/core';
import { observabilityApi } from '../src/lib/api/domains/observability';
import { adminApi } from '../src/lib/api/domains/admin';
import { MfaRequiredError, StepUpRequiredError } from '../src/lib/api/errors';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = jest.fn<AnyFn>(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => String(body),
    headers: new Headers(headers),
    blob: async () => new Blob(['x']),
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const core = () => new ApiCore();

describe('logExport — MFA refusal', () => {
  it('raises MfaRequiredError and dispatches the shell\'s mfa-required event', async () => {
    respond(401, { code: 'MFA_REQUIRED', message: 'Your organization requires two-factor authentication for administrative actions' });
    const seen: Array<{ code?: string; message?: string }> = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('mfa-required', listener);

    await expect(observabilityApi(core()).logExport({ window: { kind: 'preset', key: '1h' } } as never)).rejects.toBeInstanceOf(MfaRequiredError);
    expect(seen).toEqual([expect.objectContaining({ code: 'MFA_REQUIRED', message: expect.stringMatching(/administrative actions/) })]);
    window.removeEventListener('mfa-required', listener);
  });

  it('keeps an ordinary failure an ordinary error, with the server\'s wording', async () => {
    respond(403, { message: 'Forbidden' });
    await expect(observabilityApi(core()).logExport({ window: { kind: 'preset', key: '1h' } } as never)).rejects.toThrow('Forbidden');
  });

  it('returns the blob with the server\'s filename, sent with no-store and the client header', async () => {
    const fetchMock = respond(200, null, { 'Content-Disposition': 'attachment; filename="org-logs.jsonl"' });
    const out = await observabilityApi(core()).logExport({ window: { kind: 'preset', key: '1h' }, format: 'jsonl' } as never);
    expect(out.filename).toBe('org-logs.jsonl');
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.cache).toBe('no-store');
    expect(init.headers['X-Pb-Client']).toBe('web');
  });
});

describe('getOrgNamespaceYaml — step-up route', () => {
  it('surfaces a step-up refusal as StepUpRequiredError', async () => {
    respond(401, { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' });
    await expect(adminApi(core()).getOrgNamespaceYaml('org-1')).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('returns the YAML text on success', async () => {
    respond(200, 'apiVersion: v1');
    await expect(adminApi(core()).getOrgNamespaceYaml('org-1')).resolves.toBe('apiVersion: v1');
  });
});
