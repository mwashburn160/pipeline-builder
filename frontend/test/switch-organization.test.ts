// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /auth/switch-org` answers with an ACCESS token only — it never mints or
 * rotates the session's refresh token (the HttpOnly cookie stays as it is and
 * renews into the new org). The client must take that response as a complete
 * switch: replace the access token and nothing else.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { authApi } from '../src/lib/api/domains/auth';
import type { ApiCore } from '../src/lib/api/core';

function fakeCore(response: unknown) {
  const core = {
    request: jest.fn<AnyFn>(async () => response),
    setTokens: jest.fn<AnyFn>(),
    clearTokens: jest.fn<AnyFn>(),
  };
  return core;
}

describe('authApi.switchOrganization', () => {
  it('takes an access-token-only response: replaces the access token, leaves the session alone', async () => {
    const core = fakeCore({ success: true, data: { accessToken: 'org-2.jwt', expiresIn: 900 } });
    await authApi(core as unknown as ApiCore).switchOrganization('org-2');

    expect(core.request).toHaveBeenCalledTimes(1);
    expect(core.request).toHaveBeenCalledWith('/api/auth/switch-org', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ organizationId: 'org-2' }),
    }));
    expect(core.setTokens).toHaveBeenCalledWith({ accessToken: 'org-2.jwt', expiresIn: 900 });
    expect(core.clearTokens).not.toHaveBeenCalled();
  });

  it('fails loudly on a 2xx without an access token, keeping the old session', async () => {
    const core = fakeCore({ success: true, data: {}, message: 'nope' });
    await expect(authApi(core as unknown as ApiCore).switchOrganization('org-2')).rejects.toThrow('nope');
    expect(core.setTokens).not.toHaveBeenCalled();
    expect(core.clearTokens).not.toHaveBeenCalled();
  });
});
