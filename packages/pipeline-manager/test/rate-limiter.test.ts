// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from '../src/utils/rate-limiter.js';

const STATE_FILE = path.join(os.tmpdir(), '.pipeline-manager-auth-state.json');

beforeEach(() => {
  // Clean state between tests
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
});

afterAll(() => {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
});

describe('rate-limiter', () => {
  describe('checkAuthRateLimit', () => {
    it('should allow when no failures recorded', () => {
      expect(checkAuthRateLimit()).toBeNull();
    });

    it('should allow after a few failures', () => {
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();
      expect(checkAuthRateLimit()).toBeNull();
    });

    it('should block after 5 failures', () => {
      for (let i = 0; i < 5; i++) recordAuthFailure();
      const msg = checkAuthRateLimit();
      expect(msg).not.toBeNull();
      expect(msg).toContain('Too many failed login attempts');
    });
  });

  describe('recordAuthSuccess', () => {
    it('should reset failure counter', () => {
      for (let i = 0; i < 5; i++) recordAuthFailure();
      expect(checkAuthRateLimit()).not.toBeNull();

      recordAuthSuccess();
      expect(checkAuthRateLimit()).toBeNull();
    });
  });

  describe('recordAuthFailure', () => {
    it('should persist state to file', () => {
      recordAuthFailure();
      expect(fs.existsSync(STATE_FILE)).toBe(true);

      // State is now keyed per identifier; no-arg calls use the `_default` bucket.
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state._default.failures).toBe(1);
    });

    it('should increment failure count', () => {
      recordAuthFailure();
      recordAuthFailure();

      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state._default.failures).toBe(2);
    });

    it('keys lockout state per identifier (one account does not lock another)', () => {
      for (let i = 0; i < 5; i++) recordAuthFailure('alice@example.com', 'https://x');
      expect(checkAuthRateLimit('alice@example.com', 'https://x')).not.toBeNull();
      expect(checkAuthRateLimit('bob@example.com', 'https://x')).toBeNull();
    });
  });
});
