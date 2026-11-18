// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { isSystemOrgId, SYSTEM_ORG_ID } from '../src/middleware/system-org.js';

describe('isSystemOrgId', () => {
  it('matches the system org id', () => {
    expect(isSystemOrgId(SYSTEM_ORG_ID)).toBe(true);
    expect(isSystemOrgId(SYSTEM_ORG_ID.toUpperCase())).toBe(true);
  });

  it('never matches on an org NAME — a tenant called "system" is not the system org', () => {
    expect(isSystemOrgId('65f0000000000000000000aa')).toBe(false);
    expect(isSystemOrgId('system')).toBe(false);
    expect(isSystemOrgId('System')).toBe(false);
  });

  it('is false for an absent id', () => {
    expect(isSystemOrgId()).toBe(false);
    expect(isSystemOrgId('')).toBe(false);
  });
});
