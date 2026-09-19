// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { effectiveRetentionDays, maxRangeDaysFor } from '../helpers/retention-cap.js';

/**
 * The org's EFFECTIVE report retention, read-only. Mounted under
 * `/reports/retention` with the standard report-read gate (`reports:read`) and
 * deliberately NOT `advanced_reporting`: the Retention Pack is sold to every
 * tier and widens the standard (Pipelines/Plugins) reports too, so an org
 * without the DORA entitlement must still be able to see the horizon it bought.
 * (`GET /reports/settings/incidents` carries retention as well, but sits behind
 * the DORA gate — reading it here instead is what stops a non-DORA org from
 * falling back to the 30-day default and warning about a window it paid for.)
 *
 * `GET /` → `{ retention: { eventRetentionDays, doraRetentionDays,
 *            eventMaxRangeDays, doraMaxRangeDays } }`
 *  - `*RetentionDays` — the effective horizon (`-1` = unlimited).
 *  - `*MaxRangeDays`  — the widest window a report will serve: the horizon
 *    clamped to the absolute 730-day report ceiling. The UI caps its date
 *    range at this, so it never issues a request the backend would narrow.
 */
export function createRetentionRoutes(): Router {
  const router = Router();

  router.get('/', withRoute(async ({ res, ctx, orgId }) => {
    const settings = await reportingService.getIncidentSettings(orgId);
    const eventRetentionDays = effectiveRetentionDays(settings, 'event');
    const doraRetentionDays = effectiveRetentionDays(settings, 'dora');
    ctx.log('COMPLETED', 'Read effective report retention', { eventRetentionDays, doraRetentionDays });
    return sendSuccess(res, 200, {
      retention: {
        eventRetentionDays,
        doraRetentionDays,
        eventMaxRangeDays: maxRangeDaysFor(eventRetentionDays),
        doraMaxRangeDays: maxRangeDaysFor(doraRetentionDays),
      },
    });
  }));

  return router;
}
