// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rule 6's provenance marker, on the wire.
 *
 * `proposal-commit.ts` passes `{ proposedByAgent: true }` to the api client;
 * these tests assert what the client then PUTS ON THE REQUEST — the
 * `X-PB-Proposed-By` header, carrying the shared constant — for every write the
 * Ask panel's confirm path can make, and nothing at all for an ordinary call.
 *
 * A header rather than a body field is the whole design: the assertions below
 * check `init.headers`, and each one also checks the JSON body is untouched, so
 * a future "simplification" that folds provenance into the payload fails here.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { ASK_AGENT_PROPOSER } from '@pipeline-builder/api-core/ask-proposals';
import { ApiCore } from '@/lib/api/core';
import { complianceApi } from '@/lib/api/domains/compliance';
import { pipelineTemplatesApi } from '@/lib/api/domains/pipeline-templates';
import { pipelinesApi } from '@/lib/api/domains/pipelines';
import { pluginsApi } from '@/lib/api/domains/plugins';
import { reportingApi } from '@/lib/api/domains/reporting';

type Call = { path: string; init?: RequestInit };

/** A core that records requests but uses the REAL header builder. */
function fakeCore() {
  const calls: Call[] = [];
  const core = {
    request: jest.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return { success: true, data: {} }; }),
    // Not a re-implementation: the production method itself, so a change to the
    // header name or value is a failure here rather than a silent divergence.
    proposedByHeader: ApiCore.prototype.proposedByHeader,
  };
  return { core: core as unknown as ApiCore, calls };
}

const HEADER = 'X-PB-Proposed-By';
const AGENT = { proposedByAgent: true } as const;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every write the Ask confirm path can make, by the api method it calls. */
const WRITES: Array<{ name: string; call: (api: any, opts?: unknown) => Promise<unknown> }> = [
  { name: 'createPipeline', call: (a, o) => a.pipelines.createPipeline({ project: 'p', organization: 'o', props: {} }, o) },
  { name: 'updatePipeline', call: (a, o) => a.pipelines.updatePipeline('p1', { pipelineName: 'x' }, o) },
  { name: 'deployGeneratedPlugin', call: (a, o) => a.plugins.deployGeneratedPlugin({ name: 'n', version: '1', dockerfile: 'FROM x' }, o) },
  { name: 'updatePlugin', call: (a, o) => a.plugins.updatePlugin('pl1', { description: 'x' }, o) },
  { name: 'updatePluginSecurityNotifications', call: (a, o) => a.plugins.updatePluginSecurityNotifications({ notifyRescan: false }, o) },
  { name: 'createPipelineTemplate', call: (a, o) => a.templates.createPipelineTemplate({ name: 't', props: {} }, o) },
  { name: 'updatePipelineTemplate', call: (a, o) => a.templates.updatePipelineTemplate('t1', { name: 't2' }, o) },
  { name: 'putReportingSettings', call: (a, o) => a.reporting.putReportingSettings({ incidentWindowHours: 48 }, o) },
  { name: 'updateComplianceNotificationPreference', call: (a, o) => a.compliance.updateComplianceNotificationPreference({ emailEnabled: true }, o) },
];

function apis(core: ApiCore) {
  return {
    pipelines: pipelinesApi(core),
    plugins: pluginsApi(core),
    templates: pipelineTemplatesApi(core),
    reporting: reportingApi(core),
    compliance: complianceApi(core),
  };
}

describe('proposedByHeader', () => {
  it('builds the marker from the shared constant, or nothing at all', () => {
    const build = ApiCore.prototype.proposedByHeader;
    expect(build(AGENT)).toEqual({ [HEADER]: ASK_AGENT_PROPOSER });
    expect(build({ proposedByAgent: false })).toEqual({});
    expect(build({})).toEqual({});
    expect(build()).toEqual({});
  });

  it('offers no way to name a different proposer', () => {
    // The signature takes a boolean, not a string: there is no free-text path
    // from a caller to the header's value.
    expect(ApiCore.prototype.proposedByHeader.length).toBeLessThanOrEqual(1);
  });
});

describe('the provenance header on every Ask-committable write', () => {
  for (const { name, call } of WRITES) {
    it(`${name} sends it when the write is an agent draft`, async () => {
      const { core, calls } = fakeCore();
      await call(apis(core), AGENT);
      expect(calls).toHaveLength(1);
      expect((calls[0].init?.headers ?? {}) as Record<string, string>).toEqual({ [HEADER]: ASK_AGENT_PROPOSER });
      // It is NOT in the payload — that is the point of using a header.
      expect(String(calls[0].init?.body ?? '')).not.toContain('proposedBy');
      expect(String(calls[0].init?.body ?? '')).not.toContain(ASK_AGENT_PROPOSER);
    });

    it(`${name} sends nothing for an ordinary call`, async () => {
      const { core, calls } = fakeCore();
      await call(apis(core));
      expect(calls).toHaveLength(1);
      expect((calls[0].init?.headers ?? {}) as Record<string, string>).toEqual({});
    });
  }
});
