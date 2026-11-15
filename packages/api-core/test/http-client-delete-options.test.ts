// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `InternalHttpClient.delete` sends no body, so its options must refuse one AT
 * COMPILE TIME. A caller once passed `body` behind a cast and the peer received
 * nothing; these `@ts-expect-error` lines fail `typecheck:tests` the moment a
 * body becomes assignable again.
 */

import { describe, it, expect } from '@jest/globals';
import type { InternalHttpClient, createSafeClient } from '../src/services/http-client.js';

type DeleteOptions = NonNullable<Parameters<InternalHttpClient['delete']>[1]>;
type SafeDeleteOptions = NonNullable<Parameters<ReturnType<typeof createSafeClient>['delete']>[1]>;

describe('InternalHttpClient.delete options', () => {
  it('refuses a body at the type level', () => {
    // @ts-expect-error a DELETE carries no body
    const literal: DeleteOptions = { body: { repo: 'x' } };
    const withBody = { headers: { 'x-a': '1' }, body: 'payload' };
    // @ts-expect-error a body smuggled in through a variable is refused too
    const viaVariable: DeleteOptions = withBody;
    // @ts-expect-error the safe client's delete has the same options
    const safe: SafeDeleteOptions = { body: 'payload' };
    const fine: DeleteOptions = { headers: { 'x-a': '1' }, timeout: 1000, idempotent: true };
    expect([literal, viaVariable, safe, fine]).toHaveLength(4);
  });
});
