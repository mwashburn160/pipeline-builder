// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every id a domain client puts into a request PATH is one path segment.
 *
 * Ids often come straight from the page URL (`/dashboard/admin/orgs/[orgId]`,
 * `?message=`), and Next.js hands dynamic segments over decoded. An id
 * interpolated raw lets a crafted link aim the signed-in viewer's request — a
 * DELETE behind a button included — at another route: `a/../../users/u1`
 * resolves to `/api/users/u1/…`. Encoded, it stays inside its own segment.
 */

import { describe, expect, it } from '@jest/globals';
import type { ApiCore } from '@/lib/api/core';
import { adminApi } from '@/lib/api/domains/admin';
import { askApi } from '@/lib/api/domains/ask';
import { authApi } from '@/lib/api/domains/auth';
import { billingApi } from '@/lib/api/domains/billing';
import { complianceApi } from '@/lib/api/domains/compliance';
import { ecosystemApi } from '@/lib/api/domains/ecosystem';
import { messagesApi } from '@/lib/api/domains/messages';
import { observabilityApi } from '@/lib/api/domains/observability';
import { organizationsApi } from '@/lib/api/domains/organizations';
import { pipelineTemplatesApi } from '@/lib/api/domains/pipeline-templates';
import { pipelinesApi } from '@/lib/api/domains/pipelines';
import { pluginInstallsApi } from '@/lib/api/domains/plugin-installs';
import { pluginRetentionApi } from '@/lib/api/domains/plugin-retention';
import { pluginReviewsApi } from '@/lib/api/domains/plugin-reviews';
import { pluginsApi } from '@/lib/api/domains/plugins';
import { registryApi } from '@/lib/api/domains/registry';
import { reportingApi } from '@/lib/api/domains/reporting';
import { reportingBenchmarkApi } from '@/lib/api/domains/reporting-benchmark';
import { reportingDeliveryApi } from '@/lib/api/domains/reporting-delivery';
import { reportingFlowApi } from '@/lib/api/domains/reporting-flow';
import { reportingInsightsApi } from '@/lib/api/domains/reporting-insights';
import { reportingSecurityApi } from '@/lib/api/domains/reporting-security';
import { stakeholderReportsApi } from '@/lib/api/domains/stakeholder-reports';
import { toolchainApi } from '@/lib/api/domains/toolchain';

const HOSTILE = 'a/../../evil';

/** A core that records every `/api/…` path it is asked for and answers emptily. */
function recordingCore(paths: string[]): ApiCore {
  return new Proxy({}, {
    get: () => (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('/api/')) paths.push(args[0]);
      return Promise.resolve({ success: true, data: {} });
    },
  }) as unknown as ApiCore;
}

const CLIENTS = {
  adminApi, askApi, authApi, billingApi, complianceApi, ecosystemApi, messagesApi, observabilityApi,
  organizationsApi, pipelineTemplatesApi, pipelinesApi, pluginInstallsApi, pluginRetentionApi,
  pluginReviewsApi, pluginsApi, registryApi, reportingApi, reportingBenchmarkApi, reportingDeliveryApi,
  reportingFlowApi, reportingInsightsApi, reportingSecurityApi, stakeholderReportsApi, toolchainApi,
} as const;

describe('domain clients keep ids inside their path segment', () => {
  it.each(Object.entries(CLIENTS))('%s', async (_name, factory) => {
    const paths: string[] = [];
    const api = (factory as (core: ApiCore) => Record<string, unknown>)(recordingCore(paths));
    const offenders: string[] = [];
    for (const [method, fn] of Object.entries(api)) {
      if (typeof fn !== 'function') continue;
      const before = paths.length;
      // Every string parameter gets the hostile id; whatever else a method
      // wanted, it only forwards it.
      try {
        await Promise.resolve((fn as (...a: unknown[]) => unknown)(HOSTILE, HOSTILE, HOSTILE, HOSTILE)).catch(() => undefined);
      } catch { /* a method that needs a real body */ }
      for (const path of paths.slice(before)) {
        const segments = path.split(/[?#]/)[0].split('/');
        if (segments.includes('..') || segments.includes('evil')) offenders.push(`${method}: ${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
