// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fixed security rate limits (`src/config/rate-limits.ts`).
 *
 * These are brute-force / enumeration floors, deliberately not env-tunable.
 * Pinning every value here means loosening (or tightening) one is a deliberate,
 * reviewed edit of BOTH the table and this test — never a drive-by change.
 *
 * The source scan keeps the table the single home for them: no `createLimiter({`
 * call in platform/src may carry a numeric literal for `windowMs` or `max`; it
 * reads either this table or an env-backed config value.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from '@jest/globals';
import { AUTH_RATE_LIMITS } from '../src/config/rate-limits.js';

const SRC = join(process.cwd(), 'src');
const MINUTE = 60_000;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

/** The `{ ... }` argument of every `createLimiter({` call, by balanced braces. */
function createLimiterCalls(): Array<{ where: string; body: string }> {
  const calls: Array<{ where: string; body: string }> = [];
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bcreateLimiter\(\{/g)) {
      const start = m.index! + m[0].length - 1;
      let depth = 0;
      let end = start;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      const line = text.slice(0, m.index).split('\n').length;
      calls.push({ where: `${relative(process.cwd(), file)}:${line}`, body: text.slice(start, end + 1) });
    }
  }
  return calls;
}

describe('AUTH_RATE_LIMITS', () => {
  it('pins every fixed security limit', () => {
    expect(AUTH_RATE_LIMITS).toEqual({
      stepUp: { windowMs: MINUTE, max: 5 },
      exchangeKey: { windowMs: MINUTE, max: 60 },
      exchangeIp: { windowMs: MINUTE, max: 300 },
      mfaVerify: { windowMs: MINUTE, max: 10 },
      passwordResetIp: { windowMs: 15 * MINUTE, max: 20 },
      passwordResetEmail: { windowMs: 15 * MINUTE, max: 3 },
      domainJoin: { windowMs: MINUTE, max: 15 },
      deviceStart: { windowMs: MINUTE, max: 10 },
      devicePollCode: { windowMs: MINUTE, max: 30 },
      devicePollIp: { windowMs: MINUTE, max: 300 },
      deviceApproval: { windowMs: MINUTE, max: 15 },
      domainVerify: { windowMs: MINUTE, max: 10 },
    });
  });

  it('every entry is used by exactly one limiter', () => {
    const src = tsFiles(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const name of Object.keys(AUTH_RATE_LIMITS)) {
      expect([name, src.match(new RegExp(`AUTH_RATE_LIMITS\\.${name}\\.windowMs\\b`, 'g'))?.length ?? 0]).toEqual([name, 1]);
      expect([name, src.match(new RegExp(`AUTH_RATE_LIMITS\\.${name}\\.max\\b`, 'g'))?.length ?? 0]).toEqual([name, 1]);
    }
  });
});

describe('createLimiter call sites', () => {
  it('none uses a numeric literal for windowMs or max', () => {
    const calls = createLimiterCalls();
    // Sanity: the scan actually finds the limiters (12 fixed + 7 env-backed).
    expect(calls.length).toBeGreaterThanOrEqual(19);
    const offenders = calls
      .filter(({ body }) => /\b(windowMs|max)\s*:\s*[-+(]?\s*\d/.test(body))
      .map(({ where }) => where);
    expect(offenders).toEqual([]);
  });
});
