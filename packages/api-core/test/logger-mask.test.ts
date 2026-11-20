// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { createLogger } from '../src/utils/logger.js';

/** Run one entry through the logger's format pipeline (what the transport would print). */
function render(meta: Record<string, unknown>): Record<string, unknown> {
  const logger = createLogger('mask-test');
  return logger.format.transform({ level: 'info', message: 'm', ...meta }) as Record<string, unknown>;
}

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl';

describe('logger value masking', () => {
  it('masks a secret-shaped top-level string value', () => {
    expect(JSON.stringify(render({ detail: `got ${JWT}` }))).not.toContain(JWT);
  });

  it('masks secret-shaped string values nested in objects and arrays', () => {
    const out = render({
      request: { url: '/x?token=abc123', headers: { via: `Bearer ${JWT}` } },
      attempts: [{ note: `retrying with ${JWT}` }, 'postgres://u:hunter2@db/x'],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('hunter2');
    // Non-secret structure survives.
    expect((out.request as { url: string }).url).toBe('/x?token=[REDACTED]');
  });
});

describe('logger value masking leaves routing ids alone', () => {
  // ~1% of random 24-hex org ids (and 32-hex trace ids) contain a run of 12
  // decimal digits, which is AWS-account-id-shaped. Masking it would misfile the
  // line into the `_infra` Loki tenant (promtail routes by orgId) and break
  // trace correlation.
  const ORG_ID = '6740a1bc123456789012cdef';
  const TRACE_ID = 'abcdefabcd123456789012abcdefabcd';

  it('does not mask orgId, userId or trace_id', () => {
    const out = render({ orgId: ORG_ID, userId: ORG_ID, trace_id: TRACE_ID });
    expect(out.orgId).toBe(ORG_ID);
    expect(out.userId).toBe(ORG_ID);
    expect(out.trace_id).toBe(TRACE_ID);
  });

  it('still masks an account id in the message and other fields', () => {
    const out = render({ message: 'account 123456789012 failed', note: 'acct 123456789012' });
    expect(String(out.message)).not.toContain('123456789012');
    expect(String(out.note)).not.toContain('123456789012');
  });
});
