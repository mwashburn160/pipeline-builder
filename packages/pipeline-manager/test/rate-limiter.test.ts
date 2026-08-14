// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from '../src/utils/rate-limiter.js';

const STATE_FILE = path.join(os.tmpdir(), '.pipeline-manager-auth-state.json');
const LOCK_DIR = `${STATE_FILE}.lock`;

function cleanup() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
  try { fs.rmdirSync(LOCK_DIR); } catch { /* ignore */ }
}

beforeEach(cleanup);
afterAll(cleanup);

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

  describe('concurrency-safe read-modify-write', () => {
    it('releases the lock after a successful update (no leaked lock dir)', () => {
      recordAuthFailure();
      recordAuthSuccess();
      expect(fs.existsSync(LOCK_DIR)).toBe(false);
    });

    it('writes valid, non-torn JSON via atomic rename', () => {
      for (let i = 0; i < 3; i++) recordAuthFailure();
      // A completed write must always be parseable (rename is atomic).
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state._default.failures).toBe(3);
      // No temp files left behind.
      const strays = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('.pipeline-manager-auth-state.json.') && f.endsWith('.tmp'));
      expect(strays).toEqual([]);
    });

    it('reclaims a stale lock left by a crashed process', () => {
      // Simulate a crashed owner: create the lock dir and back-date its mtime past
      // the stale threshold so the next writer reclaims it instead of hanging.
      fs.mkdirSync(LOCK_DIR);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(LOCK_DIR, past, past);

      recordAuthFailure();

      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state._default.failures).toBe(1);
      expect(fs.existsSync(LOCK_DIR)).toBe(false);
    });
  });
});
