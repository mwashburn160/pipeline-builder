// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one rendering of a `429 QUOTA_EXCEEDED` the CLI and the plugin-lookup
 * Lambda share — and the line between a quota refusal and a plain rate limit.
 */

import { describe, it, expect } from '@jest/globals';
import { describeQuotaExceeded, isQuotaExceededBody } from '../src/core/quota-exceeded.js';

const body = {
  success: false,
  code: 'QUOTA_EXCEEDED',
  message: 'API call quota exceeded',
  details: { quotaType: 'apiCalls', limit: 25000, used: 25000, resetAt: '2026-11-05T00:00:00.000Z', upgradeUrl: '/dashboard/billing' },
};

describe('describeQuotaExceeded', () => {
  it('names the quota, the numbers, the reset date and the upgrade page on the platform', () => {
    expect(describeQuotaExceeded(body, 'https://pb.example.com/')).toBe(
      'API call quota reached (25,000/25,000); resets 2026-11-05. Upgrade: https://pb.example.com/dashboard/billing',
    );
  });

  it('is undefined for a plain 429 (a rate limit keeps rate-limit wording)', () => {
    expect(describeQuotaExceeded({ code: 'RATE_LIMITED', message: 'slow down' }, 'https://x')).toBeUndefined();
    expect(describeQuotaExceeded('Too Many Requests', 'https://x')).toBeUndefined();
    expect(isQuotaExceededBody(null)).toBe(false);
  });

  it('degrades gracefully on a sparse body, and never follows an absolute upgrade URL', () => {
    expect(describeQuotaExceeded({ code: 'QUOTA_EXCEEDED', details: { upgradeUrl: 'https://evil.example' } }, 'https://pb')).toBe(
      'Usage quota reached (?/?); resets at the end of the period. Upgrade: https://pb/dashboard/billing',
    );
  });
});
