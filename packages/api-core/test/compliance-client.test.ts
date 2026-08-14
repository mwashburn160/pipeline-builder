// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the fail-closed compliance enforcement gate (services/compliance-client.ts).
 *
 * The client's whole contract is safety-critical: a plugin upload / pipeline
 * create is BLOCKED unless compliance affirmatively passes it, EXCEPT when the
 * operator opts into fail-open via COMPLIANCE_BYPASS. These tests pin:
 *  - non-2xx from compliance → throw (fail-closed)
 *  - a 2xx with no `data` payload → throw (fail-closed; can't trust an empty verdict)
 *  - COMPLIANCE_BYPASS=true → a transport error is swallowed into a pass-through
 *  - COMPLIANCE_BYPASS=false (default) → a transport error propagates (fail-closed)
 *  - validation POSTs are marked idempotent (+ tighter timeout) so a transient
 *    blip retries instead of wrongly rejecting a legit request (F4).
 *
 * COMPLIANCE_BYPASS is read at module-load, so each variant loads a fresh module
 * instance (resetModules + re-register mocks) with the env set beforehand.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type PostFn = (...args: any[]) => Promise<any>;
const mockPost = jest.fn<PostFn>();

async function loadClient(bypass: boolean) {
  jest.resetModules();
  process.env.COMPLIANCE_BYPASS = bypass ? 'true' : 'false';
  jest.unstable_mockModule('../src/utils/logger.js', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  }));
  jest.unstable_mockModule('../src/services/http-client.js', () => ({
    InternalHttpClient: jest.fn().mockImplementation(() => ({ post: mockPost })),
  }));
  const mod = await import('../src/services/compliance-client.js');
  return mod.createComplianceClient({ host: 'compliance', port: 3000 });
}

const PASS = {
  passed: true,
  blocked: false,
  violations: [],
  warnings: [],
  rulesEvaluated: 3,
  rulesSkipped: 0,
  exemptionsApplied: [],
};

describe('compliance-client (fail-closed enforcement gate)', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  describe('COMPLIANCE_BYPASS off (default fail-closed)', () => {
    it('returns the verdict on a 2xx with data', async () => {
      const client = await loadClient(false);
      mockPost.mockResolvedValue({ statusCode: 200, body: { success: true, data: PASS } });
      await expect(client.validatePlugin('org1', { a: 1 }, 'Bearer t')).resolves.toEqual(PASS);
    });

    it('THROWS on a non-2xx response (does not silently pass)', async () => {
      const client = await loadClient(false);
      mockPost.mockResolvedValue({ statusCode: 503, body: { message: 'service unavailable' } });
      await expect(client.validatePlugin('org1', { a: 1 }, 'Bearer t'))
        .rejects.toThrow(/service unavailable/);
    });

    it('THROWS on a 2xx that carries no data payload', async () => {
      const client = await loadClient(false);
      mockPost.mockResolvedValue({ statusCode: 200, body: { success: true } });
      await expect(client.validatePipeline('org1', { a: 1 }, 'Bearer t'))
        .rejects.toThrow(/no data/);
    });

    it('propagates a transport error (fail-closed — blocks the operation)', async () => {
      const client = await loadClient(false);
      mockPost.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.validatePlugin('org1', { a: 1 }, 'Bearer t'))
        .rejects.toThrow(/ECONNREFUSED/);
    });

    it('marks validation POSTs idempotent with a bounded timeout (F4 retry-before-fail-closed)', async () => {
      const client = await loadClient(false);
      mockPost.mockResolvedValue({ statusCode: 200, body: { data: PASS } });
      await client.validatePlugin('org1', { a: 1 }, 'Bearer t');
      const [path, , options] = mockPost.mock.calls[0];
      expect(path).toBe('/compliance/validate/plugin');
      expect(options).toMatchObject({ idempotent: true });
      expect(typeof options.timeout).toBe('number');
      expect(options.headers).toMatchObject({ 'x-org-id': 'org1', 'Authorization': 'Bearer t' });
    });
  });

  describe('COMPLIANCE_BYPASS on (fail-open)', () => {
    it('swallows a transport error into a pass-through verdict', async () => {
      const client = await loadClient(true);
      mockPost.mockRejectedValue(new Error('compliance down'));
      const result = await client.validatePlugin('org1', { a: 1 }, 'Bearer t');
      expect(result.passed).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.warnings[0].message).toMatch(/skipped/i);
    });

    it('swallows a non-2xx into a pass-through verdict', async () => {
      const client = await loadClient(true);
      mockPost.mockResolvedValue({ statusCode: 500, body: { message: 'boom' } });
      const result = await client.validatePipeline('org1', { a: 1 }, 'Bearer t');
      expect(result.passed).toBe(true);
      expect(result.blocked).toBe(false);
    });
  });
});
