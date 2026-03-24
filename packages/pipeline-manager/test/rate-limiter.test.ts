import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from '../src/utils/rate-limiter';

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

      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state.failures).toBe(1);
    });

    it('should increment failure count', () => {
      recordAuthFailure();
      recordAuthFailure();

      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      expect(state.failures).toBe(2);
    });
  });
});
