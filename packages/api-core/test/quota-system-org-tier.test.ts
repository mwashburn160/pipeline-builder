// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's tier is answered without a lookup.
 *
 * Both directions matter and they fail differently, which is why both are
 * pinned:
 *
 *   getTier       fails OPEN to DEFAULT_TIER — `developer` when billing is on,
 *                 the most constrained tier there is. Its documented job is
 *                 build-queue partitioning, so a quota-service blip used to
 *                 route the SYSTEM org's builds onto the developer queue. The
 *                 Official catalog load is 119 of them.
 *   getTierStrict fails CLOSED to null, for decisions that must not guess, so
 *                 a sweep would skip the platform's own org entirely.
 *
 * Neither outcome is acceptable for an org whose tier is a constant. The test
 * makes the service UNREACHABLE on purpose: if the short-circuit is ever
 * removed, these are the two assertions that break.
 */

import { describe, expect, it } from '@jest/globals';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import { createQuotaService } from '../src/services/quota.js';

/** Points the client at a port nothing listens on, so every call fails. */
const unreachable = () => createQuotaService({ baseUrl: 'http://127.0.0.1:1', timeout: 50 } as never);

describe('system-org tier is a constant, not a lookup', () => {
  it('getTier answers unlimited even when the quota service is unreachable', async () => {
    expect(await unreachable().getTier(SYSTEM_ORG_ID, 'Bearer x')).toBe('unlimited');
  });

  it('getTierStrict answers unlimited rather than null', async () => {
    expect(await unreachable().getTierStrict(SYSTEM_ORG_ID, 'Bearer x')).toBe('unlimited');
  });

  it('matches the system org id case-insensitively', async () => {
    expect(await unreachable().getTier(SYSTEM_ORG_ID.toUpperCase(), 'Bearer x')).toBe('unlimited');
  });

  it('does NOT short-circuit any other org — they still go to the service', async () => {
    // The whole value is that this is narrow. A tenant must never inherit the
    // platform's tier by accident, so an ordinary org still takes the normal
    // fail-open path rather than being answered `unlimited` for free.
    const tier = await unreachable().getTier('000000000000000000000999', 'Bearer x');
    expect(tier).not.toBe('unlimited');
    expect(await unreachable().getTierStrict('000000000000000000000999', 'Bearer x')).toBeNull();
  });
});
