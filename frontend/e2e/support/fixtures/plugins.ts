// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin data for the plugin journeys: a catalog row the list renders, the
 * dry-run `POST /plugins/inspect` result the upload's Catalog details step
 * shows, and an SSE responder for a build's log stream.
 */

import type { Page } from '@playwright/test';

export const PLUGIN_ID = '44444444-4444-4444-8444-444444444444';

/** One `GET /plugins` row (the fields the list and its columns read). */
export function pluginRow(over: Record<string, unknown> = {}) {
  return {
    id: PLUGIN_ID, orgId: 'org-1', name: 'cdk-lint', version: '1.2.0', description: 'Lint CDK apps', keywords: ['cdk'],
    category: 'quality', metadata: {}, pluginType: 'CodeBuildStep', computeType: 'SMALL', env: {}, installCommands: [], commands: ['cdk-lint'],
    uri: 'org-1/cdk-lint:1.2.0', buildType: 'build_image', imageDigest: `sha256:${'a'.repeat(64)}`, imageSource: 'built',
    lifecycle: 'production', visibility: 'org', isActive: true, isDefault: false,
    createdBy: 'u-1', createdAt: '2026-11-20T00:00:00Z', updatedBy: 'u-1', updatedAt: '2026-11-20T00:00:00Z',
    ...over,
  };
}

export const listOf = (plugins: unknown[]) => ({
  json: { success: true, data: { plugins, pagination: { total: plugins.length, limit: 25, offset: 0, hasMore: false } } },
});

export const INSPECT_RESULT = {
  plugin: { name: 'cdk-lint', version: '1.2.0', pluginType: 'CodeBuildStep', buildType: 'build_image' },
  fields: [
    { field: 'displayName', value: 'CDK Lint', source: 'manifest', error: null },
    { field: 'summary', value: 'Lint CDK apps before synth', source: 'manifest', error: null },
  ],
};

export interface BuildEventStub { type: 'INFO' | 'ERROR' | 'COMPLETED'; message: string; data?: Record<string, unknown> }

/**
 * Answer a build's SSE log stream (`GET /api/plugins/logs/:requestId`) with
 * `events`, then end the response. Registered after `stubBackend`, so it wins
 * over the JSON catch-all for this one path (the ticket POST still falls
 * through to it).
 */
export async function streamBuildLog(page: Page, requestId: string, events: BuildEventStub[]): Promise<{ opened: () => number }> {
  let opened = 0;
  await page.route(`**/api/plugins/logs/${requestId}?**`, async (route) => {
    opened += 1;
    const body = events
      .map((e, i) => `data: ${JSON.stringify({ ts: `2026-11-27T00:00:0${i}Z`, ...e })}\n\n`)
      .join('');
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body });
  });
  return { opened: () => opened };
}
