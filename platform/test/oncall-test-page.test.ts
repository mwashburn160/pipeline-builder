// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /observability/oncall-test — the answer is always a 200 whose body says
 * what happened. A provider refusal used to be a 502, which the client turns
 * into a throw, dropping the `error` that says why the page did not go out.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSend = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecordAuditEvent = jest.fn();

mockConfig();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendPagerDutyEvent: (...a: unknown[]) => mockSend(...a),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockRecordAuditEvent(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn(), observe: jest.fn() }));

const { oncallTest } = await import('../src/controllers/oncall.js');

async function page() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  await oncallTest({ user: { sub: 'admin-1' } } as any, res);
  return { status: res.status.mock.calls[0][0] as number, body: (res.json.mock.calls[0][0] as { data: unknown }).data };
}

describe('POST /observability/oncall-test', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('a delivered page is 200 { sent: true }', async () => {
    mockSend.mockResolvedValue({ ok: true, status: 202 });
    expect(await page()).toEqual({ status: 200, body: { sent: true, skipped: false, status: 202 } });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'support.oncall.test', outcome: 'success' }));
  });

  it('a provider refusal is STILL 200, with sent: false and the provider error', async () => {
    mockSend.mockResolvedValue({ ok: false, status: 400, error: 'Invalid routing key' });
    expect(await page()).toEqual({ status: 200, body: { sent: false, skipped: false, status: 400, error: 'Invalid routing key' } });
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.oncall.test', outcome: 'failure', details: expect.objectContaining({ sent: false }),
    }));
  });

  it('the knob being off is 200 { sent: false, skipped: true }', async () => {
    mockSend.mockResolvedValue({ ok: true, skipped: true });
    expect(await page()).toEqual({ status: 200, body: { sent: false, skipped: true, status: undefined } });
  });
});
