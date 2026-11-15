// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OnCallPagingPanel's "Send test page".
 *
 * `POST /observability/oncall-test` always answers 200 and the body is the
 * answer: `sent` is the only success, `skipped` means paging is switched off
 * (nothing left the building — never shown green), and `sent: false` carries
 * the provider's refusal, with its HTTP status when it answered.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { pageToast } from './helpers/pageMocks';
import { OnCallPagingPanel } from '../src/components/admin/OnCallPagingPanel';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const oncallTest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    oncallStatus: async () => ({
      success: true,
      data: {
        enabled: true, provider: 'pagerduty', routingKeyConfigured: true, endpointConfigured: true,
        ackWebhookConfigured: true, rotaReadable: true, rotaEntries: 1, lookaheadHours: 24, wouldPage: true,
      },
    }),
    oncallTest: (...a: unknown[]) => oncallTest(...a),
  },
}));

async function sendTest(body: Record<string, unknown>) {
  oncallTest.mockResolvedValue({ success: true, data: body });
  render(<OnCallPagingPanel canManage />);
  const button = await screen.findByRole('button', { name: /send a test page/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(oncallTest).toHaveBeenCalled());
}

describe('OnCallPagingPanel — test page outcome', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('reports a sent page as accepted', async () => {
    await sendTest({ sent: true, skipped: false, status: 202 });
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith(expect.stringMatching(/accepted by the provider/)));
    expect(pageToast.error).not.toHaveBeenCalled();
  });

  it('says paging is switched off when skipped, never success', async () => {
    await sendTest({ sent: false, skipped: true });
    await waitFor(() => expect(pageToast.info).toHaveBeenCalledWith(expect.stringMatching(/paging is disabled/i)));
    expect(pageToast.success).not.toHaveBeenCalled();
  });

  it("shows the provider's error and status when it refused", async () => {
    await sendTest({ sent: false, skipped: false, status: 400, error: 'Invalid routing key' });
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('Invalid routing key (HTTP 400)'));
  });

  it("shows the provider's error alone when it was unreachable", async () => {
    await sendTest({ sent: false, skipped: false, error: 'connect ECONNREFUSED' });
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('connect ECONNREFUSED'));
  });
});
