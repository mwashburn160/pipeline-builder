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
