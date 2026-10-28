// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SCIM and impersonation tunables used to be literals, so changing the SCIM
 * rate limit or shortening the impersonation window was a code change — the env
 * docs said so in as many words. They are now read through api-core's `envInt`.
 *
 * Both modules are deliberately DEPENDENCY-FREE (the response helper, the scope
 * gate, the token helper and the routes all share them, and pulling them through
 * a service would drag the config + model graph into a middleware and into every
 * suite that mocks it). So they take `envInt` from the `lib/*` SUBPATH, not the
 * api-core barrel: `utils/env.ts` has no imports of its own, and a suite that
 * mocks `@pipeline-builder/api-core` partially would otherwise make `envInt`
 * throw, since `stubModule` refuses a non-overridden export.
 *
 * What this suite pins is the three behaviours that matter and differ:
 *   - an override is honoured,
 *   - garbage falls back to the code default (envInt is strict where `parseInt`
 *     would accept `50.5` and `12abc`),
 *   - a value below the floor CLAMPS to the floor rather than falling back to
 *     the default. Those last two are easy to conflate and land far apart: a
 *     typo'd impersonation TTL silently keeping 15 minutes is very different
 *     from one silently becoming 1 minute.
 *
 * The values are read at MODULE LOAD, so each case sets env then imports.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

const KNOBS = [
  'SCIM_RATE_LIMIT_MAX', 'SCIM_RATE_LIMIT_WINDOW_MS', 'SCIM_DEFAULT_COUNT', 'SCIM_MAX_COUNT',
  'SCIM_MAX_MEMBERS_PER_REQUEST', 'IMPERSONATION_SESSION_TTL_MS', 'IMPERSONATION_REQUEST_TTL_MS',
] as const;
const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

type Scim = typeof import('../src/constants/scim.js');
type Imp = typeof import('../src/constants/impersonation.js');
let scim: Scim;
let imp: Imp;

beforeAll(async () => {
  process.env.SCIM_RATE_LIMIT_MAX = '1200'; // honoured
  process.env.SCIM_MAX_COUNT = 'not-a-number'; // strict fallback
  process.env.SCIM_DEFAULT_COUNT = '50.5'; // a decimal is NOT an integer
  process.env.IMPERSONATION_SESSION_TTL_MS = '1000'; // below the 60s floor -> clamps
  process.env.IMPERSONATION_REQUEST_TTL_MS = '7200000';
  scim = await import('../src/constants/scim.js');
  imp = await import('../src/constants/impersonation.js');
});

describe('SCIM tunables', () => {
  it('honours an override (the limit is no longer a code change)', () => {
    expect(scim.SCIM_RATE_LIMIT_MAX).toBe(1200);
  });

  it('falls back to the default on garbage, and on a decimal', () => {
    expect(scim.SCIM_MAX_COUNT).toBe(200); // `parseInt('50.5')` is 50, which is how a typo ships a value nobody wrote.
    expect(scim.SCIM_DEFAULT_COUNT).toBe(100);
  });

  it('leaves unset knobs at their defaults', () => {
    expect(scim.SCIM_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(scim.SCIM_MAX_MEMBERS_PER_REQUEST).toBe(500);
  });

  it('keeps the PROTOCOL constants literal — they are not deployment settings', () => {
    expect(scim.SCIM_CONTENT_TYPE).toBe('application/scim+json');
    expect(scim.SCIM_USER_SCHEMA).toBe('urn:ietf:params:scim:schemas:core:2.0:User');
  });
});

describe('impersonation TTLs', () => {
  it('clamps a below-floor value to the floor, NOT to the default', () => {
    // 1000 is below the 60s floor. Clamping means a careless operator gets the
    // shortest USABLE window; falling back would have silently restored 15
    // minutes — the opposite of what they asked for, on a privileged feature.
    expect(imp.IMPERSONATION_SESSION_TTL_MS).toBe(60_000);
  });

  it('honours a longer approval window', () => {
    expect(imp.IMPERSONATION_REQUEST_TTL_MS).toBe(7_200_000);
  });

  it('still describes whatever duration it ends up with', () => {
    // The user-facing text is derived, so an override must not produce prose
    // that contradicts the real TTL.
    expect(imp.describeDuration(imp.IMPERSONATION_REQUEST_TTL_MS)).toBe('2 hours');
    expect(imp.describeDuration(imp.IMPERSONATION_SESSION_TTL_MS)).toBe('1 minute');
  });
});
