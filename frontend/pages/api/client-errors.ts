// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-origin relay for browser error reports (served publicly at
 * `/client-errors` via the rewrite in next.config.js). Forwards to the runtime
 * `ERROR_REPORT_URL` collector; a no-op when that env is unset. See
 * `src/lib/error-report-relay.ts` for why this isn't a direct browser beacon.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { createRelayLimiter, relayClientError, REPORTING_STATE_HEADER } from '@/lib/error-report-relay';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const allow = createRelayLimiter();

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
    return;
  }
  const endpoint = process.env.ERROR_REPORT_URL || undefined;
  res.setHeader(REPORTING_STATE_HEADER, endpoint ? 'on' : 'off');
  // Always 204: the reporter is fire-and-forget, and the outcome (dropped,
  // rate-limited, collector down) is not the browser's to act on.
  await relayClientError(req.body, { endpoint, allow });
  res.status(204).end();
}
