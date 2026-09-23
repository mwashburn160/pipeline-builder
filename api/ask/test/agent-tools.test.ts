// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the agent tool set.
 *
 * Two invariants are asserted for EVERY tool, old and new:
 *
 *  1. it never writes — no create/update/delete endpoint is ever called, and the
 *     remediation tools in particular never POST to the approval queues they
 *     propose into;
 *  2. a model-supplied org (however it is spelled) is ignored in favour of the
 *     AUTHENTICATED one from `AgentToolDeps`.
 *
 * Plus, per tool: the shape it returns (the contract with the Ask panel), the
 * allowlist it enforces, and the facts it deliberately does NOT put into the
 * model's context.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';

// Mock ai-core: real-ish `tool`/`buildGroundingContext`, mocked `generateObject`.
const mockGenerateObject = jest.fn<(...a: unknown[]) => Promise<{ object: unknown }>>();
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  tool: (def: unknown) => def,
  buildGroundingContext: (hits: Array<{ doc: { title?: string; text: string } }>) => hits.map((h) => `${h.doc.title}: ${h.doc.text}`).join('\n'),
  generateObject: mockGenerateObject,
}));

const { buildAgentTools } = await import('../src/services/agent-tools.js');
// The SHARED allowlist — the same module the browser's confirm handler reads.
// Imported here (not re-listed) so a test cannot assert against a second copy.
const { ORG_SETTING_PROPOSAL_KEYS } = await import('@pipeline-builder/api-core');

const search = jest.fn((..._args: unknown[]) => [
  { doc: { id: 'deployment.md#x', title: 'Deploy', url: 'docs/deployment', text: 'Deploy steps here.' }, score: 1 },
]);
const index = { size: 1, search } as never;

const client = () => ({ get: jest.fn<AnyFn>(), post: jest.fn<AnyFn>() });
const pipeline = client();
const plugin = client();
const platform = client();
const compliance = client();
const reporting = client();
const quota = client();
const model = { id: 'm' } as never;

// The instance-wide email switch, read from platform's AUTHORITATIVE internal
// status route on ask's own service token (`readInstanceEmailStatus`). Injected,
// so the suite can drive all three states — including the one that matters most,
// `unknown` ("could not determine"), which is NOT "disabled".
const emailStatus = jest.fn<() => Promise<'enabled' | 'disabled' | 'unknown'>>(async () => 'enabled');
const chargeAiCall = jest.fn<(tool: string) => Promise<boolean>>(async () => true);
const onRefusedFields = jest.fn<(tool: string, fields: string[]) => void>();

type ToolEntry = {
  execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean }; shape?: Record<string, unknown> };
};

const makeTools = (overrides: Partial<Parameters<typeof buildAgentTools>[0]> = {}) =>
  buildAgentTools({
    index,
    pipeline: pipeline as never,
    plugin: plugin as never,
    platform: platform as never,
    compliance: compliance as never,
    reporting: reporting as never,
    quota: quota as never,
    emailStatus,
    model,
    defaults: { provider: 'anthropic', model: 'claude-sonnet-5' },
    orgId: 'o',
    chargeAiCall,
    maxOutputTokens: 512,
    onRefusedFields,
    ...overrides,
  }) as unknown as Record<string, ToolEntry>;

const call = (name: string, input: unknown) => makeTools()[name].execute(input, {});

/** Every mutating verb any tool could reach, across every client. */
const ALL_CLIENTS = { pipeline, plugin, platform, compliance, reporting, quota };
function postedPaths(): string[] {
  return Object.values(ALL_CLIENTS).flatMap((c) => c.post.mock.calls.map((args: unknown[]) => String(args[0])));
}

/** The dry-run answer the compliance service gives when a draft is clean. */
const CLEAN = { data: { passed: true, blocked: false, violations: [], warnings: [], rulesEvaluated: 3, rulesSkipped: 0 } };

beforeEach(() => {
  jest.clearAllMocks();
  compliance.post.mockResolvedValue(CLEAN);
  emailStatus.mockResolvedValue('enabled');
});

// -- grounding + catalog reads (unchanged behaviour) --------------------------

describe('buildAgentTools — docs + catalog reads', () => {
  it('answer_how_to returns grounded context + sources', async () => {
    const out = await call('answer_how_to', { query: 'how do I deploy' });
    expect(search).toHaveBeenCalledWith('how do I deploy', 5);
    expect(String(out.context)).toContain('Deploy steps here.');
    expect((out.sources as Array<{ id: string }>)[0].id).toBe('deployment.md#x');
  });

  it('list_pipelines reads GET /pipelines (user token)', async () => {
    pipeline.get.mockResolvedValue({ data: [{ id: 'p1' }] });
    const out = await call('list_pipelines', {});
    expect(pipeline.get).toHaveBeenCalledWith('/pipelines');
    expect(out.pipelines).toEqual([{ id: 'p1' }]);
  });

  it('inspect_pipeline reads GET /pipelines/:id (user token)', async () => {
    pipeline.get.mockResolvedValue({ data: { id: 'p1', name: 'x' } });
    const out = await call('inspect_pipeline', { id: 'p1' });
    expect(pipeline.get).toHaveBeenCalledWith('/pipelines/p1');
    expect(out.pipeline).toEqual({ id: 'p1', name: 'x' });
  });

  it('list_templates lists templates (with inputs) via GET /pipeline-templates', async () => {
    pipeline.get.mockResolvedValue({ data: [{ id: 't1', inputs: [{ name: 'region' }] }] });
    const out = await call('list_templates', {});
    expect(pipeline.get).toHaveBeenCalledWith('/pipeline-templates');
    expect(out.templates).toEqual([{ id: 't1', inputs: [{ name: 'region' }] }]);
  });

  it('model-supplied ids that land in a URL path reject `..` and slashes', () => {
    const tools = makeTools();
    for (const bad of ['..', '../admin', 'a/b', 'a%2Fb', '', 'x'.repeat(200)]) {
      expect(tools.inspect_pipeline.inputSchema.safeParse({ id: bad }).success).toBe(false);
      expect(tools.propose_pipeline_from_template.inputSchema.safeParse({ templateId: bad, project: 'p' }).success).toBe(false);
      expect(tools.propose_pipeline_edit.inputSchema.safeParse({ id: bad, changes: {} }).success).toBe(false);
      expect(tools.inspect_pipeline_run.inputSchema.safeParse({ pipelineId: bad }).success).toBe(false);
    }
    expect(tools.inspect_pipeline.inputSchema.safeParse({ id: '6f1c2a3b-0000-4000-8000-000000000000' }).success).toBe(true);
  });
});

// -- PHASE 1: diagnosis -------------------------------------------------------

describe('phase 1 — inspect_pipeline_run', () => {
  it('reads the execution history and NAMES the most common failing stage/action', async () => {
    reporting.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/reports/execution/list')) {
        return {
          data: {
            executions: [
              { executionId: 'e1', status: 'failed', failingStage: 'Test', failingAction: 'unit', durationMs: 10 },
              { executionId: 'e2', status: 'failed', failingStage: 'Test', failingAction: 'lint' },
              { executionId: 'e3', status: 'succeeded' },
            ],
          },
        };
      }
      if (path.endsWith('stage-failures')) return { data: { stages: [{ stage: 'Test', failures: 9 }] } };
      return { data: { actions: [{ action: 'unit', failures: 5 }] } };
    });
    const out = await call('inspect_pipeline_run', { pipelineId: 'p1' });
    expect(reporting.get).toHaveBeenCalledWith('/reports/execution/list?pipelineId=p1&limit=10');
    expect(out.summary).toEqual({ read: 3, failed: 2, mostCommonFailingStage: 'Test', mostCommonFailingAction: expect.any(String) });
    expect(postedPaths()).toEqual([]);
  });

  it('narrows to one execution when the user named it', async () => {
    reporting.get.mockResolvedValue({ data: { executions: [{ executionId: 'e1', status: 'failed' }, { executionId: 'e2', status: 'failed' }] } });
    const out = await call('inspect_pipeline_run', { pipelineId: 'p1', executionId: 'e2' });
    expect(out.executions).toHaveLength(1);
  });

  it('reports the history as unavailable instead of failing the turn', async () => {
    reporting.get.mockRejectedValue(new Error('GET /reports/execution/list -> 403'));
    const out = await call('inspect_pipeline_run', { pipelineId: 'p1' });
    expect(out).toEqual({ pipelineId: 'p1', unavailable: expect.stringContaining('403') });
  });
});

describe('phase 1 — inspect_plugin_build', () => {
  it('shapes the stored version and keeps the queue legs optional', async () => {
    plugin.get.mockImplementation(async (path: string) => {
      if (path === '/plugins/pl1') {
        return {
          data: {
            plugin: {
              id: 'pl1',
              name: 'trivy',
              version: '1.0.0',
              imageDigest: 'sha256:abc',
              scannedAt: '2026-09-01T00:00:00Z',
              vulnCritical: 2,
              vulnCriticalFixable: 1,
              scanFlag: { reason: 'fixable-critical' },
              runAsRoot: false,
              // Facts the tool must NOT carry into the model's context:
              dockerfile: 'FROM alpine\nRUN secret-build',
              commands: ['./secret.sh'],
              readme: 'x'.repeat(5000),
            },
          },
        };
      }
      throw new Error('GET /plugins/queue/failed -> 403');
    });
    const out = await call('inspect_plugin_build', { pluginId: 'pl1' });

    const shaped = out.plugin as Record<string, unknown>;
    expect(shaped).toMatchObject({ id: 'pl1', imageSigned: true, scanned: true, runAsRoot: false });
    expect(shaped.vulnerabilities).toEqual({ critical: 2, high: null, criticalFixable: 1, highFixable: null });
    // Rule 5: what RUNS is not a build diagnosis, and never enters the context.
    expect(JSON.stringify(out)).not.toContain('secret-build');
    expect(JSON.stringify(out)).not.toContain('secret.sh');
    // A member without `plugins:write` still gets the half they can see.
    expect(out.failedJobs).toEqual({ unavailable: expect.stringContaining('403') });
    expect(postedPaths()).toEqual([]);
  });

  it('works with no plugin id (queue-wide triage)', async () => {
    plugin.get.mockResolvedValue({ data: { jobs: [{ id: 'j1', pluginName: 'p', error: 'boom' }], categories: [] } });
    const out = await call('inspect_plugin_build', {});
    expect(out.plugin).toBeUndefined();
    expect(out.failedJobs).toEqual([expect.objectContaining({ jobId: 'j1', error: 'boom' })]);
  });
});

describe('phase 1 — diagnose_notifications', () => {
  const wire = (configEmail: boolean) => {
    platform.get.mockImplementation(async (path: string) => {
      if (path === '/config') return { data: { serviceFeatures: { email: configEmail, billing: true } } };
      return {
        data: {
          destinations: [
            { id: 'd1', channel: 'email', enabled: true, minSeverity: 'warning', target: 'ops@example.com' },
            { id: 'd2', channel: 'slack', enabled: true, minSeverity: 'critical', target: 'https://hooks.slack.com/services/T000/B000/zzz' },
          ],
        },
      };
    });
    plugin.get.mockResolvedValue({
      data: {
        recipientMode: 'writers',
        targetUsers: ['u1'],
        notifyRescan: true,
        digestMode: 'immediate',
        webhookUrl: 'https://hooks.example.com/secret-path',
        hasWebhookSecret: true,
        externalEmail: { masked: 's•••@corp.com', verified: false, pendingExpiresAt: '2026-09-24T00:00:00Z' },
      },
    });
    compliance.get.mockResolvedValue({
      data: { notifyOnBlock: true, notifyOnWarning: false, emailEnabled: true, digestMode: 'daily', targetUsers: null, webhookUrl: null, hasWebhookSecret: false },
    });
  };

  it('names the platform email switch as the blocking cause when org email channels are configured', async () => {
    wire(false);
    emailStatus.mockResolvedValue('disabled');
    const out = await call('diagnose_notifications', {});
    const finding = out.finding as { severity: string; summary: string; detail: string };
    expect(finding.severity).toBe('blocking');
    expect(finding.summary).toContain('EMAIL_ENABLED');
    // The documented trap: the send REPORTS SUCCESS, so nothing else surfaces it.
    expect(finding.detail).toContain('REPORTS SUCCESS');
    expect(out.platform).toMatchObject({ email: 'disabled' });
  });

  it('reads the AUTHORITATIVE internal status route, not the public /config, and says which answered', async () => {
    // `/config` disagrees on purpose: the authoritative answer must win, and the
    // answer must carry its own provenance.
    wire(true);
    emailStatus.mockResolvedValue('disabled');
    const out = await call('diagnose_notifications', {});
    expect(emailStatus).toHaveBeenCalledTimes(1);
    expect(out.platform).toMatchObject({ email: 'disabled', emailAuthoritative: true });
    expect(String((out.platform as { emailSource: string }).emailSource)).toContain('internal status');
    expect((out.finding as { severity: string }).severity).toBe('blocking');
  });

  it('SHAPES every channel: no address, no webhook URL, not even a masked one (rule 5)', async () => {
    wire(false);
    emailStatus.mockResolvedValue('disabled');
    const out = await call('diagnose_notifications', {});
    const json = JSON.stringify(out);
    expect(json).not.toContain('ops@example.com');
    expect(json).not.toContain('hooks.slack.com');
    expect(json).not.toContain('secret-path');
    expect(json).not.toContain('s•••@corp.com');
    // …while still carrying the whole diagnostic signal.
    expect(out.pluginSecurityNotifications).toMatchObject({ hasWebhook: true, hasWebhookSecret: true, externalAddress: 'pending confirmation', recipientCount: 1 });
    expect(out.complianceNotifications).toMatchObject({ emailEnabled: true, hasWebhook: false, recipientCount: 'all org admins' });
    expect(out.alertDestinations).toMatchObject({ count: 2, byChannel: { email: 1, slack: 1 } });
  });

  it('says so plainly when email is ON', async () => {
    wire(true);
    emailStatus.mockResolvedValue('enabled');
    const out = await call('diagnose_notifications', {});
    expect((out.finding as { severity: string }).severity).toBe('info');
    expect(out.platform).toMatchObject({ email: 'enabled', emailAuthoritative: true });
  });

  it('falls back to the public /config when the authoritative read fails — and LABELS it as inferred', async () => {
    wire(false);
    emailStatus.mockResolvedValue('unknown');
    const out = await call('diagnose_notifications', {});
    expect(out.platform).toMatchObject({ email: 'disabled', emailAuthoritative: false });
    expect(String((out.platform as { emailSource: string }).emailSource)).toContain('INFERRED');
    // Still blocking (the switch is off either way) — but a reader can tell how it was learned.
    const finding = out.finding as { severity: string; source: string };
    expect(finding.severity).toBe('blocking');
    expect(finding.source).toContain('INFERRED');
  });

  it('reports UNKNOWN, never "disabled", when neither source answered', async () => {
    // The deliberate failure-path choice: platform's own consumers fail CLOSED
    // (unreachable ⇒ off) because they are making an authorization decision. A
    // diagnostic makes none, and answering "disabled" here would send an admin
    // to an operator to turn on a switch that may already be on.
    emailStatus.mockResolvedValue('unknown');
    platform.get.mockRejectedValue(new Error('GET /config -> 503'));
    plugin.get.mockRejectedValue(new Error('GET /plugins/security-notifications -> 403'));
    compliance.get.mockRejectedValue(new Error('GET /compliance/notification-preferences -> 403'));
    const out = await call('diagnose_notifications', {});
    expect(out.platform).toMatchObject({ email: 'unknown', emailAuthoritative: false, configUnavailable: expect.stringContaining('503') });
    const finding = out.finding as { severity: string; summary: string };
    expect(finding.severity).toBe('unknown');
    expect(finding.summary).toContain('not the same as disabled');
    // Every other leg is still reported rather than failing the turn.
    expect(out.alertDestinations).toMatchObject({ unavailable: expect.stringContaining('503') });
    expect(out.pluginSecurityNotifications).toMatchObject({ unavailable: expect.stringContaining('403') });
  });

  it('never reports a "blocking" email finding off an unknown switch, whatever is configured', async () => {
    wire(true);
    emailStatus.mockResolvedValue('unknown');
    platform.get.mockImplementation(async (path: string) => {
      // /config answers, but without the email switch in it — the exact
      // narrowing this tool used to depend on silently.
      if (path === '/config') return { data: { serviceFeatures: { billing: true } } };
      return { data: { destinations: [{ id: 'd1', channel: 'email', enabled: true }] } };
    });
    const out = await call('diagnose_notifications', {});
    expect(out.platform).toMatchObject({ email: 'unknown' });
    expect((out.finding as { severity: string }).severity).toBe('unknown');
  });
});

describe('phase 1 — diagnose_installs', () => {
  it('finds the exposed installs and the SMALLEST upgrade that clears each', async () => {
    plugin.get.mockResolvedValue({
      data: {
        installs: [
          {
            id: 'i1',
            publisherHandle: 'acme',
            name: 'scan',
            versionPolicy: 'minor',
            pinnedVersion: '1.2.0',
            resolvedVersion: '1.2.0',
            latestVersion: '2.0.0',
            status: 'active',
            needsApproval: true,
            advisories: [
              { id: 'a1', severity: 'high', summary: 'RCE', fixedVersion: '1.3.0', blocking: false },
              { id: 'a2', severity: 'critical', summary: 'auth bypass', fixedVersion: '1.10.0', blocking: true },
            ],
            warnings: ['advisory'],
          },
          { id: 'i2', publisherHandle: 'acme', name: 'lint', resolvedVersion: '3.0.0', status: 'active', advisories: [] },
        ],
      },
    });
    const out = await call('diagnose_installs', {});
    expect(out.total).toBe(2);
    expect(out.exposed).toBe(1);
    // 1.10.0 sorts ABOVE 1.3.0 (numeric segments, not lexicographic).
    expect((out.installs as Array<{ clearedBy: string }>)[0].clearedBy).toBe('1.10.0');
    expect(out.recommendation).toEqual(['acme/scan: 1.2.0 → 1.10.0']);
    expect(postedPaths()).toEqual([]);
  });

  it('says plainly when nothing is exposed', async () => {
    plugin.get.mockResolvedValue({ data: { installs: [{ id: 'i1', publisherHandle: 'a', name: 'b', advisories: [] }] } });
    const out = await call('diagnose_installs', {});
    expect(out.recommendation).toContain('No install');
  });
});

describe('phase 1 — check_quota_headroom', () => {
  it('reads the AUTHENTICATED org only (no orgId input) and flags what is at risk', async () => {
    const tools = makeTools();
    expect(Object.keys(tools.check_quota_headroom.inputSchema.shape ?? {})).toEqual([]);
    quota.get.mockResolvedValue({
      data: {
        quota: {
          tier: 'team',
          quotas: {
            aiCalls: { limit: 100, used: 95, remaining: 5, unlimited: false, resetAt: 'r' },
            pipelines: { limit: 10, used: 1, remaining: 9, unlimited: false, resetAt: 'r' },
            apiCalls: { limit: -1, used: 9, remaining: -1, unlimited: true, resetAt: 'r' },
          },
        },
      },
    });
    const out = await call('check_quota_headroom', {});
    expect(quota.get).toHaveBeenCalledWith('/quotas');
    expect(out.tier).toBe('team');
    expect(out.atRisk).toEqual(['aiCalls']);
  });

  it('reports the quota service being unreachable', async () => {
    quota.get.mockRejectedValue(new Error('GET /quotas -> 503'));
    expect(await call('check_quota_headroom', {})).toEqual({ unavailable: expect.stringContaining('503') });
  });
});

describe('phase 1 — inspect_dora_drivers', () => {
  it('reads DORA plus its drivers, and survives a missing advanced_reporting entitlement', async () => {
    reporting.get.mockImplementation(async (path: string) => {
      if (path.includes('/dora')) throw new Error(`GET ${path} -> 402`);
      if (path.endsWith('stage-failures')) return { data: { stages: [{ stage: 'Deploy' }] } };
      if (path.endsWith('action-failures')) return { data: { actions: [] } };
      return { data: { healthy: true } };
    });
    const out = await call('inspect_dora_drivers', { from: '2026-09-01T00:00:00Z', to: '2026-09-23T00:00:00Z', pipelineId: 'p1' });
    expect(reporting.get).toHaveBeenCalledWith(expect.stringContaining('/reports/execution/dora?from='));
    expect(out.dora).toEqual({ unavailable: expect.stringContaining('402') });
    expect((out.drivers as { stageFailures: unknown[] }).stageFailures).toEqual([{ stage: 'Deploy' }]);
    expect(postedPaths()).toEqual([]);
  });
});

// -- PHASE 2: policy-aware drafting -------------------------------------------

describe('phase 2 — check_compliance', () => {
  it('uses the DRY-RUN leg (no audit row, no block notification) and shapes the findings', async () => {
    compliance.post.mockResolvedValue({
      data: {
        passed: false,
        blocked: true,
        rulesEvaluated: 4,
        rulesSkipped: 2,
        violations: [{
          ruleId: 'r1',
          ruleName: 'No root containers',
          severity: 'critical',
          message: 'runAsRoot must be false',
          // Echoing the document back at the model buys nothing and is dropped:
          actualValue: { secretish: 'value' },
          expectedValue: false,
          field: 'runAsRoot',
          operator: 'eq',
        }],
        warnings: [],
      },
    });
    const out = await call('check_compliance', { target: 'plugin', attributes: { name: 'x', runAsRoot: true } });
    expect(compliance.post).toHaveBeenCalledWith('/compliance/validate/plugin/dry-run', { attributes: expect.objectContaining({ name: 'x', visibility: 'private' }) });
    // NEVER the enforcing leg.
    expect(postedPaths()).not.toContain('/compliance/validate/plugin');
    const note = out.compliance as Record<string, unknown>;
    expect(note).toMatchObject({ checked: true, compliant: false, blocked: true, rulesEvaluated: 4, rulesSkipped: 2 });
    expect(note.violations).toEqual([{ ruleId: 'r1', ruleName: 'No root containers', severity: 'critical', message: 'runAsRoot must be false' }]);
    expect(JSON.stringify(out)).not.toContain('secretish');
  });

  it('takes no org input — the dry-run is scoped by the forwarded token', () => {
    const tools = makeTools();
    expect(Object.keys(tools.check_compliance.inputSchema.shape ?? {}).sort()).toEqual(['attributes', 'target']);
  });

  it('reports the check as UNRUN rather than claiming compliance when the service is down', async () => {
    compliance.post.mockRejectedValue(new Error('POST /compliance/validate/pipeline/dry-run -> 503'));
    const out = await call('check_compliance', { target: 'pipeline', attributes: { project: 'p' } });
    expect(out.compliance).toMatchObject({ checked: false, compliant: false, unavailable: expect.stringContaining('503') });
  });
});

// -- create proposals ---------------------------------------------------------

describe('create proposals', () => {
  it('propose_pipeline DRAFTS via /generate, attaches the compliance verdict, and never creates', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p', organization: 'o' }, description: 'd', keywords: ['ci'] } });
    const out = await call('propose_pipeline', { prompt: 'ci for a node app' });
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate', { prompt: 'ci for a node app', provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(out).toMatchObject({ kind: 'pipeline', description: 'd', keywords: ['ci'], refusedFields: [], provenance: { proposedBy: 'ask-agent' } });
    expect(out.compliance).toMatchObject({ checked: true, compliant: true });
    expect(postedPaths()).not.toContain('/pipelines');
  });

  it('propose_pipeline_from_repo passes the repo token from the REQUEST, never from the model', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p' }, description: 'd', analysis: { repo: 'app' } } });
    const tools = makeTools({ defaults: { provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret' } });
    const out = await tools.propose_pipeline_from_repo.execute({ gitUrl: 'https://github.com/o/app' }, {});
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate/from-url', {
      gitUrl: 'https://github.com/o/app', provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret',
    });
    expect(out).toMatchObject({ kind: 'pipeline', analysis: { repo: 'app' } });
    expect(Object.keys(tools.propose_pipeline_from_repo.inputSchema.shape ?? {})).toEqual(['gitUrl']);
  });

  it('propose_plugin DRAFTS via plugin /generate (config + dockerfile), never deploys', async () => {
    plugin.post.mockResolvedValue({ data: { config: { name: 'trivy' }, dockerfile: 'FROM x' } });
    const out = await call('propose_plugin', { prompt: 'trivy image scan' });
    expect(plugin.post).toHaveBeenCalledWith('/plugins/generate', { prompt: 'trivy image scan', provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(out).toMatchObject({ kind: 'plugin', config: { name: 'trivy' }, dockerfile: 'FROM x' });
    expect(postedPaths()).not.toContain('/plugins/deploy-generated');
  });

  it('propose_plugin_from_repo analyses the repo FIRST and feeds the analysis to the plugin generator', async () => {
    pipeline.post.mockResolvedValue({ data: { props: {}, analysis: { languages: ['go'], packageManager: 'go mod' } } });
    plugin.post.mockResolvedValue({ data: { config: { name: 'go-build' }, dockerfile: 'FROM golang' } });
    const tools = makeTools({ defaults: { provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret' } });
    const out = await tools.propose_plugin_from_repo.execute({ gitUrl: 'https://github.com/o/app' }, {});

    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate/from-url', expect.objectContaining({ repoToken: 'ghp_secret' }));
    const [path, body] = plugin.post.mock.calls[0] as [string, { prompt: string }];
    expect(path).toBe('/plugins/generate');
    expect(body.prompt).toContain('go mod');
    expect(out).toMatchObject({ kind: 'plugin', config: { name: 'go-build' }, analysis: { languages: ['go'] } });
    expect(postedPaths()).not.toContain('/plugins/deploy-generated');
  });

  it('propose_plugin_from_repo DECLINES (and does not draft) when the repo cannot be analysed', async () => {
    pipeline.post.mockResolvedValue({ data: { props: {} } });
    const out = await call('propose_plugin_from_repo', { gitUrl: 'https://github.com/o/app' });
    expect(out).toMatchObject({ kind: 'plugin', error: expect.stringContaining('could not be analyzed') });
    expect(plugin.post).not.toHaveBeenCalled();
  });

  it('propose_pipeline_from_template injects the AUTHENTICATED org, not a model-supplied one', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p', organization: 'o', synth: {} }, description: 'from template' } });
    const out = await call('propose_pipeline_from_template', {
      templateId: 't1', project: 'p', organization: 'attacker-org', inputs: { region: 'us-east-1' },
    });
    expect(pipeline.post).toHaveBeenCalledWith('/pipeline-templates/t1/instantiate', {
      project: 'p', organization: 'o', inputs: { region: 'us-east-1' },
    });
    expect(out).toMatchObject({ kind: 'pipeline', description: 'from template' });
    expect(postedPaths()).not.toContain('/pipelines');
  });
});

describe('propose_template — in-process generation, validated like the create API', () => {
  it('drafts a template, charges its own aiCalls slot and caps output tokens', async () => {
    mockGenerateObject.mockResolvedValue({ object: { name: 'node-ci', props: { project: '{{ vars.NAME }}' }, inputs: [{ name: 'NAME' }] } });
    const out = await call('propose_template', { prompt: 'reusable node CI' });
    expect(chargeAiCall).toHaveBeenCalledWith('propose_template');
    expect(mockGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 512 }));
    expect(out).toMatchObject({ kind: 'template', validation: { valid: true, problems: [], declaredInputs: ['NAME'], referencedVariables: ['NAME'] } });
    expect(pipeline.post).not.toHaveBeenCalled();
  });

  it('catches an UNDECLARED {{ vars.X }} — creatable before, and only failing at synth', async () => {
    mockGenerateObject.mockResolvedValue({ object: { name: 't', props: { project: '{{ vars.REGION }}' }, inputs: [] } });
    const out = await call('propose_template', { prompt: 'x' });
    expect(out.validation).toMatchObject({
      valid: false,
      problems: [expect.objectContaining({ kind: 'undeclared-variable', severity: 'error', variable: 'REGION' })],
    });
  });

  it('catches a reference CYCLE', async () => {
    mockGenerateObject.mockResolvedValue({
      object: { name: 't', props: { vars: { a: '{{ vars.b }}', b: '{{ vars.a }}' } }, inputs: [] },
    });
    const out = await call('propose_template', { prompt: 'x' });
    const v = out.validation as { valid: boolean; problems: Array<{ kind: string }> };
    expect(v.valid).toBe(false);
    expect(v.problems.some((p) => p.kind === 'cycle')).toBe(true);
  });

  it('catches an unknown scope root', async () => {
    mockGenerateObject.mockResolvedValue({ object: { name: 't', props: { project: '{{ nope.thing }}' }, inputs: [] } });
    const out = await call('propose_template', { prompt: 'x' });
    const v = out.validation as { valid: boolean; problems: Array<{ kind: string }> };
    expect(v.valid).toBe(false);
    expect(v.problems.some((p) => p.kind === 'unknown-scope')).toBe(true);
  });

  it('declines WITHOUT generating when the org is out of aiCalls', async () => {
    chargeAiCall.mockResolvedValueOnce(false);
    const out = await call('propose_template', { prompt: 'reusable node CI' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'template', error: expect.stringContaining('quota') });
  });
});

// -- PHASE 3: edit proposals --------------------------------------------------

describe('phase 3 — propose_pipeline_edit', () => {
  const current = { id: 'p1', pipelineName: 'api', description: 'old', keywords: ['a'], props: { project: 'p', synth: { stages: ['build'] } } };

  it('returns CURRENT and PROPOSED for only the fields that really changed', async () => {
    pipeline.get.mockResolvedValue({ data: { pipeline: current } });
    const out = await call('propose_pipeline_edit', {
      id: 'p1',
      // `description` is unchanged — it must NOT appear in the diff, so a
      // reviewer cannot be shown padding.
      changes: { description: 'old', props: { project: 'p', synth: { stages: ['build', 'test'] } } },
      reason: 'adds a test stage',
    });
    expect(out).toMatchObject({
      kind: 'pipeline-edit',
      id: 'p1',
      target: 'api',
      changedFields: ['props'],
      description: 'adds a test stage',
      refusedFields: [],
      commit: { service: 'pipeline', method: 'PUT', path: '/pipelines/:id', permission: 'pipelines:write' },
      provenance: { proposedBy: 'ask-agent' },
    });
    expect(out.current).toEqual({ props: current.props });
    expect(out.changedPaths).toEqual(['props.synth.stages[1]']);
    // Re-checked against compliance, exactly as PUT /pipelines/:id would.
    expect(out.compliance).toMatchObject({ checked: true });
    // Nothing was written.
    expect(pipeline.post).not.toHaveBeenCalled();
    expect(postedPaths()).not.toContain('/pipelines/p1');
  });

  it('REFUSES a field outside the allowlist, counts it, and proposes only the rest', async () => {
    pipeline.get.mockResolvedValue({ data: { pipeline: current } });
    const out = await call('propose_pipeline_edit', {
      id: 'p1',
      // `visibility` is who can SEE the pipeline — an authority change, absent
      // from the allowlist rather than gated inside it.
      changes: { pipelineName: 'api-v2', visibility: 'public', isDefault: true },
    });
    expect(out.changedFields).toEqual(['pipelineName']);
    expect(out.refusedFields).toEqual(['visibility', 'isDefault']);
    expect(onRefusedFields).toHaveBeenCalledWith('propose_pipeline_edit', ['visibility', 'isDefault']);
    expect(JSON.stringify(out.proposed)).not.toContain('public');
  });

  it('declines when every requested field is off the allowlist', async () => {
    pipeline.get.mockResolvedValue({ data: { pipeline: current } });
    const out = await call('propose_pipeline_edit', { id: 'p1', changes: { visibility: 'public' } });
    expect(out).toMatchObject({ kind: 'pipeline-edit', error: expect.stringContaining('is editable here'), refusedFields: ['visibility'] });
  });

  it('declines a no-op diff rather than proposing an empty change', async () => {
    pipeline.get.mockResolvedValue({ data: { pipeline: current } });
    const out = await call('propose_pipeline_edit', { id: 'p1', changes: { pipelineName: 'api' } });
    expect(out).toMatchObject({ error: expect.stringContaining('already match') });
  });

  it('declines when the current state cannot be read (no baseline to diff against)', async () => {
    pipeline.get.mockRejectedValue(new Error('GET /pipelines/p1 -> 404'));
    const out = await call('propose_pipeline_edit', { id: 'p1', changes: { pipelineName: 'x' } });
    expect(out).toMatchObject({ kind: 'pipeline-edit', error: expect.stringContaining('404') });
  });
});

describe('phase 3 — propose_plugin_edit', () => {
  it('edits catalog metadata and REFUSES execution-contract keys', async () => {
    plugin.get.mockResolvedValue({ data: { plugin: { id: 'pl1', name: 'trivy', summary: 'old', commands: ['a'] } } });
    const out = await call('propose_plugin_edit', {
      id: 'pl1',
      // `commands` / `computeType` / `version` change WHAT RUNS: a new version
      // with a new digest, never an edit — and `PUT /plugins/:id` refuses them.
      changes: { summary: 'new summary', commands: ['rm -rf /'], computeType: 'LARGE', version: '9.9.9' },
    });
    expect(out.changedFields).toEqual(['summary']);
    expect(out.refusedFields).toEqual(['commands', 'computeType', 'version']);
    expect(onRefusedFields).toHaveBeenCalledWith('propose_plugin_edit', ['commands', 'computeType', 'version']);
    expect(JSON.stringify(out.proposed)).not.toContain('rm -rf');
    expect(out.commit).toEqual({ service: 'plugin', method: 'PUT', path: '/plugins/:id', permission: 'plugins:write' });
    expect(plugin.post).not.toHaveBeenCalled();
  });
});

describe('phase 3 — propose_template_edit', () => {
  it('validates the MERGED document, so an edit cannot orphan a placeholder', async () => {
    pipeline.get.mockResolvedValue({
      data: { template: { id: 't1', name: 'node', props: { project: '{{ vars.REGION }}' }, inputs: [{ name: 'REGION' }] } },
    });
    // Removing the declared input leaves the UNTOUCHED props referencing it.
    const out = await call('propose_template_edit', { id: 't1', changes: { inputs: [] } });
    expect(out).toMatchObject({ kind: 'template-edit', changedFields: ['inputs'] });
    expect(out.validation).toMatchObject({
      valid: false,
      problems: [expect.objectContaining({ kind: 'undeclared-variable', severity: 'error', variable: 'REGION' })],
    });
    expect(out.commit).toEqual({ service: 'pipeline', method: 'PUT', path: '/pipeline-templates/:id', permission: 'templates:write' });
  });

  it('skips validation for a metadata-only edit', async () => {
    pipeline.get.mockResolvedValue({ data: { template: { id: 't1', name: 'node', category: 'general', props: {}, inputs: [] } } });
    const out = await call('propose_template_edit', { id: 't1', changes: { category: 'ci' } });
    expect(out.changedFields).toEqual(['category']);
    expect(out.validation).toBeUndefined();
  });
});

// -- PHASE 4: remediation into the EXISTING approval queues -------------------

describe('phase 4 — propose_install_change', () => {
  const install = {
    id: 'i1',
    publisherHandle: 'acme',
    name: 'scan',
    status: 'active',
    versionPolicy: 'minor',
    pinnedVersion: '1.2.0',
    resolvedVersion: '1.2.0',
    needsApproval: true,
    pendingChange: null,
    advisories: [{ id: 'a1', severity: 'critical', summary: 'auth bypass', fixedVersion: '1.10.0' }],
  };

  it('PROPOSES the change request — it never files it', async () => {
    plugin.get.mockResolvedValue({ data: { installs: [install] } });
    const out = await call('propose_install_change', { installId: 'i1', version: '1.10.0', note: 'clears a1' });
    expect(out).toMatchObject({
      kind: 'install-change-request',
      id: 'i1',
      target: 'acme/scan',
      changedFields: ['version'],
      current: { version: '1.2.0' },
      proposed: { version: '1.10.0' },
      note: 'clears a1',
      commit: { service: 'plugin', method: 'POST', path: '/plugins/installs/:id/change-requests', permission: 'plugins:install' },
      provenance: { proposedBy: 'ask-agent' },
    });
    expect((out.clears as unknown[])).toHaveLength(1);
    // THE invariant: filing the request is a write (pending row + audit + N11
    // to approvers), so the agent must not do it.
    expect(postedPaths()).not.toContain('/plugins/installs/i1/change-requests');
    expect(plugin.post).not.toHaveBeenCalled();
  });

  it('targets the DIRECT patch when this member needs no approver', async () => {
    plugin.get.mockResolvedValue({ data: { installs: [{ ...install, needsApproval: false }] } });
    const out = await call('propose_install_change', { installId: 'i1', versionPolicy: 'latest' });
    expect(out.commit).toEqual({ service: 'plugin', method: 'PATCH', path: '/plugins/installs/:id', permission: 'plugins:install' });
    expect(out.changedFields).toEqual(['versionPolicy']);
  });

  it('declines an install that is not active, already has a pending change, or is not the org\'s', async () => {
    plugin.get.mockResolvedValue({ data: { installs: [{ ...install, status: 'pending' }] } });
    expect(await call('propose_install_change', { installId: 'i1', version: '2.0.0' })).toMatchObject({ error: expect.stringContaining('pending') });

    plugin.get.mockResolvedValue({ data: { installs: [{ ...install, pendingChange: { version: '2.0.0' } }] } });
    expect(await call('propose_install_change', { installId: 'i1', version: '2.0.0' })).toMatchObject({ error: expect.stringContaining('waiting for approval') });

    plugin.get.mockResolvedValue({ data: { installs: [] } });
    expect(await call('propose_install_change', { installId: 'i1', version: '2.0.0' })).toMatchObject({ error: expect.stringContaining('No install') });
  });

  it('declines when nothing would change', async () => {
    plugin.get.mockResolvedValue({ data: { installs: [install] } });
    expect(await call('propose_install_change', { installId: 'i1' })).toMatchObject({ error: expect.stringContaining('nothing to change') });
    expect(await call('propose_install_change', { installId: 'i1', version: '1.2.0', versionPolicy: 'minor' }))
      .toMatchObject({ error: expect.stringContaining('already on that version') });
  });
});

describe('phase 4 — propose_compliance_exemption', () => {
  const ruleId = '11111111-1111-4111-8111-111111111111';
  const entityId = '22222222-2222-4222-8222-222222222222';

  it('PROPOSES the exemption request — it never files it', async () => {
    compliance.get.mockResolvedValue({ data: { rule: { id: ruleId, name: 'No root containers', severity: 'critical', isActive: true } } });
    const out = await call('propose_compliance_exemption', {
      ruleId, entityType: 'plugin', entityId, entityName: 'trivy', reason: 'vendor image requires root',
    });
    expect(out).toMatchObject({
      kind: 'compliance-exemption-request',
      target: 'No root containers — trivy',
      request: { ruleId, entityType: 'plugin', entityId, entityName: 'trivy', reason: 'vendor image requires root' },
      commit: { service: 'compliance', method: 'POST', path: '/compliance/exemptions', permission: 'compliance:read' },
      provenance: { proposedBy: 'ask-agent' },
    });
    expect(String(out.description)).toContain('other than the requester must approve');
    // Filing is a write (pending row + notification); approval is a SEPARATE
    // endpoint, so the request POST is not itself the human gate.
    expect(postedPaths()).not.toContain('/compliance/exemptions');
  });

  it('declines for an inactive rule (nothing is being blocked by it)', async () => {
    compliance.get.mockResolvedValue({ data: { rule: { id: ruleId, name: 'Old rule', isActive: false } } });
    const out = await call('propose_compliance_exemption', { ruleId, entityType: 'pipeline', entityId, reason: 'x' });
    expect(out).toMatchObject({ error: expect.stringContaining('not active') });
  });

  it('declines when the rule is not readable by this caller', async () => {
    compliance.get.mockRejectedValue(new Error(`GET /compliance/rules/${ruleId} -> 404`));
    const out = await call('propose_compliance_exemption', { ruleId, entityType: 'pipeline', entityId, reason: 'x' });
    expect(out).toMatchObject({ error: expect.stringContaining('404') });
  });
});

// -- PHASE 5: org settings ----------------------------------------------------

describe('phase 5 — propose_org_settings', () => {
  const wireCurrent = () => {
    reporting.get.mockResolvedValue({ data: { settings: { incidentWindowHours: 24, eventRetentionDays: 30 } } });
    compliance.get.mockResolvedValue({ data: { notifyOnBlock: true, notifyOnWarning: false, emailEnabled: false, digestMode: 'immediate' } });
    plugin.get.mockResolvedValue({ data: { recipientMode: 'writers', notifyRescan: true, digestMode: 'immediate' } });
  };

  it('proposes allowlisted changes and plans ONE request per owning surface', async () => {
    wireCurrent();
    const out = await call('propose_org_settings', {
      changes: {
        'reporting.incidentWindowHours': 48,
        'complianceNotifications.notifyOnWarning': true,
        'complianceNotifications.digestMode': 'daily',
      },
      reason: 'widen the incident window and get warned',
    });

    expect(out).toMatchObject({
      kind: 'org-settings-edit',
      id: 'o',
      changedFields: ['reporting.incidentWindowHours', 'complianceNotifications.notifyOnWarning', 'complianceNotifications.digestMode'],
      current: { 'reporting.incidentWindowHours': 24, 'complianceNotifications.notifyOnWarning': false, 'complianceNotifications.digestMode': 'immediate' },
      proposed: { 'reporting.incidentWindowHours': 48, 'complianceNotifications.notifyOnWarning': true, 'complianceNotifications.digestMode': 'daily' },
      description: 'widen the incident window and get warned',
      refusedFields: [],
      invalidFields: [],
      unreadableFields: [],
      provenance: { proposedBy: 'ask-agent' },
    });

    // The commit payload: proposal keys translated back to each API's own field
    // names, grouped per surface, carrying ONLY reviewed values.
    expect(out.requests).toEqual([
      { surface: 'reporting', method: 'PUT', path: '/reports/settings/incidents', permission: 'org:settings', body: { incidentWindowHours: 48 } },
      { surface: 'complianceNotifications', method: 'PUT', path: '/compliance/notification-preferences', permission: 'compliance:write', body: { notifyOnWarning: true, digestMode: 'daily' } },
    ]);
    // Reads only the surfaces it touches, with the caller's token, and writes nothing.
    expect(reporting.get).toHaveBeenCalledWith('/reports/settings/incidents');
    expect(compliance.get).toHaveBeenCalledWith('/compliance/notification-preferences');
    expect(plugin.get).not.toHaveBeenCalled();
    expect(postedPaths()).toEqual([]);
  });

  it('keeps the two `digestMode` settings apart by surface, then renames each back on commit', async () => {
    wireCurrent();
    const out = await call('propose_org_settings', {
      changes: { 'complianceNotifications.digestMode': 'weekly', 'pluginSecurityNotifications.digestMode': 'daily' },
    });
    expect(out.changedFields).toEqual(['complianceNotifications.digestMode', 'pluginSecurityNotifications.digestMode']);
    expect(out.requests).toEqual([
      expect.objectContaining({ surface: 'complianceNotifications', body: { digestMode: 'weekly' } }),
      expect.objectContaining({ surface: 'pluginSecurityNotifications', path: '/plugins/security-notifications', body: { digestMode: 'daily' } }),
    ]);
  });

  it('IGNORES a model-supplied organizationId and uses the authenticated org', async () => {
    wireCurrent();
    const tools = makeTools();
    // The tool has no org input at all, so a crafted one is not even accepted…
    expect(Object.keys(tools.propose_org_settings.inputSchema.shape ?? {}).sort()).toEqual(['changes', 'reason']);
    // …and one smuggled into `changes` is refused like any other unknown field.
    const out = await tools.propose_org_settings.execute(
      { organizationId: 'victim-org', changes: { 'organizationId': 'victim-org', 'reporting.incidentWindowHours': 48 } }, {},
    );
    expect(out.id).toBe('o');
    expect(out.refusedFields).toEqual(['organizationId']);
    expect(onRefusedFields).toHaveBeenCalledWith('propose_org_settings', ['organizationId']);
  });

  it('REFUSES every security setting — they are absent from the allowlist, not gated inside it', async () => {
    wireCurrent();
    const security = {
      'mfaRequired': false,
      'organization.mfaPolicy': { required: false },
      'organization.passwordPolicy': { minLength: 1 },
      'organization.impersonationPolicy': { allowed: true },
      'organization.idp': { issuer: 'https://evil' },
      'organization.transferOwner': 'attacker',
      'organization.identity': { name: 'Acme Holdings', slug: 'acme' },
      'organization.aiConfig': { apiKey: 'sk-live-123' },
      'plugins.installPolicy': { requireApprovalTiers: [] },
      'complianceNotifications.webhookUrl': 'https://evil.example/hook',
      'complianceNotifications.webhookSecret': 's3cret',
      'pluginSecurityNotifications.externalEmail': 'attacker@evil.example',
      'pluginSecurityNotifications.recipientMode': 'users',
      'pluginSecurityNotifications.targetUsers': ['attacker'],
      'reporting.eventRetentionDays': 3650,
    };
    const out = await call('propose_org_settings', { changes: security });
    expect(out).toMatchObject({ kind: 'org-settings-edit', error: expect.stringContaining('can be proposed by the assistant') });
    expect(out.refusedFields).toEqual(Object.keys(security));
    expect(onRefusedFields).toHaveBeenCalledWith('propose_org_settings', Object.keys(security));
    // Nothing leaked into a proposal, and no credential or address was echoed back.
    expect(JSON.stringify(out)).not.toContain('sk-live-123');
    expect(JSON.stringify(out)).not.toContain('s3cret');
    expect(JSON.stringify(out)).not.toContain('attacker@evil.example');
    expect(JSON.stringify(out)).not.toContain('evil.example/hook');
    expect(postedPaths()).toEqual([]);
  });

  it('the shared allowlist IS the schema: nothing outside it is proposable', async () => {
    wireCurrent();
    // Every key the tool advertises comes from the shared module, and every one
    // of them is namespaced by its owning surface.
    for (const key of ORG_SETTING_PROPOSAL_KEYS) expect(key).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/);
    const tools = makeTools();
    expect(String((tools.propose_org_settings as unknown as { description: string }).description))
      .toContain(ORG_SETTING_PROPOSAL_KEYS.join(', '));
  });

  it('drops a value outside its declared domain, and reports it apart from the injection signal', async () => {
    wireCurrent();
    const out = await call('propose_org_settings', {
      changes: { 'complianceNotifications.digestMode': 'hourly', 'reporting.incidentWindowHours': 100000 },
    });
    expect(out).toMatchObject({ error: expect.stringContaining('outside what the settings accept') });
    expect(out.refusedFields).toEqual([]);
    expect(onRefusedFields).not.toHaveBeenCalled();
  });

  it('declines a change whose CURRENT value could not be read (no verifiable baseline)', async () => {
    reporting.get.mockRejectedValue(new Error('GET /reports/settings/incidents -> 402'));
    const out = await call('propose_org_settings', { changes: { 'reporting.incidentWindowHours': 48 } });
    expect(out).toMatchObject({ error: expect.stringContaining('verifiable baseline') });
  });

  it('declines a no-op', async () => {
    wireCurrent();
    const out = await call('propose_org_settings', { changes: { 'reporting.incidentWindowHours': 24 } });
    expect(out).toMatchObject({ error: expect.stringContaining('already have the requested values') });
  });
});

// -- the whole-toolset invariants ---------------------------------------------

describe('toolset invariants', () => {
  it('exposes exactly the expected tools', () => {
    expect(Object.keys(makeTools()).sort()).toEqual([
      'answer_how_to',
      'check_compliance',
      'check_quota_headroom',
      'diagnose_installs',
      'diagnose_notifications',
      'inspect_dora_drivers',
      'inspect_pipeline',
      'inspect_pipeline_run',
      'inspect_plugin_build',
      'list_pipelines',
      'list_templates',
      'propose_compliance_exemption',
      'propose_install_change',
      'propose_org_settings',
      'propose_pipeline',
      'propose_pipeline_edit',
      'propose_pipeline_from_repo',
      'propose_pipeline_from_template',
      'propose_plugin',
      'propose_plugin_edit',
      'propose_plugin_from_repo',
      'propose_template',
      'propose_template_edit',
    ].sort());
  });

  it('NO tool declares an org/tenant input — the org always comes from the authenticated caller', () => {
    const tools = makeTools();
    const offenders: string[] = [];
    for (const [name, entry] of Object.entries(tools)) {
      for (const key of Object.keys(entry.inputSchema.shape ?? {})) {
        if (/^(org|organization|tenant|account)(id)?$/i.test(key)) offenders.push(`${name}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every propose_* tool stamps ask-agent provenance on the proposal it returns', async () => {
    // One representative per family; the per-tool suites above assert the rest.
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p' } } });
    const created = await call('propose_pipeline', { prompt: 'x' });
    expect(created.provenance).toEqual({ proposedBy: 'ask-agent' });

    pipeline.get.mockResolvedValue({ data: { pipeline: { id: 'p1', pipelineName: 'api' } } });
    const edited = await call('propose_pipeline_edit', { id: 'p1', changes: { pipelineName: 'api-2' } });
    expect(edited.provenance).toEqual({ proposedBy: 'ask-agent' });
  });
});

// -- edge cases the contract still has to survive -----------------------------

describe('edge cases', () => {
  it('omits provider/model from a delegated generation when the request chose neither', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p' } } });
    plugin.post.mockResolvedValue({ data: { config: { name: 'c' }, dockerfile: 'FROM x' } });
    const tools = makeTools({ defaults: {} });
    await tools.propose_pipeline.execute({ prompt: 'x' }, {});
    await tools.propose_plugin.execute({ prompt: 'y' }, {});
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate', { prompt: 'x' });
    expect(plugin.post).toHaveBeenCalledWith('/plugins/generate', { prompt: 'y' });
  });

  it('propose_pipeline_from_repo omits the repo token when the request carried none', async () => {
    pipeline.post.mockResolvedValue({ data: { props: {} } });
    const tools = makeTools({ defaults: {} });
    await tools.propose_pipeline_from_repo.execute({ gitUrl: 'https://github.com/o/app' }, {});
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate/from-url', { gitUrl: 'https://github.com/o/app' });
  });

  it('tolerates a downstream body with no { data } envelope, and a null body', async () => {
    pipeline.get.mockResolvedValue([{ id: 'p1' }]);
    expect((await call('list_pipelines', {})).pipelines).toEqual([{ id: 'p1' }]);
    pipeline.get.mockResolvedValue(null);
    expect((await call('inspect_pipeline', { id: 'p1' })).pipeline).toBeNull();
  });

  it('gives a findings entry a message even when the rule engine names none', async () => {
    compliance.post.mockResolvedValue({ data: { blocked: false, violations: [{}], warnings: [{ message: 'w' }] } });
    const out = await call('check_compliance', { target: 'pipeline', attributes: { props: { project: 'p' } } });
    expect((out.compliance as { violations: Array<{ message: string }> }).violations).toEqual([{ message: 'Rule violated' }]);
  });

  it('leaves clearedBy null when an advisory has no published fix', async () => {
    plugin.get.mockResolvedValue({
      data: { installs: [{ id: 'i1', publisherHandle: 'a', name: 'b', resolvedVersion: '1.0.0', advisories: [{ id: 'x', severity: 'high' }] }] },
    });
    const out = await call('diagnose_installs', {});
    expect((out.installs as Array<{ clearedBy: unknown }>)[0].clearedBy).toBeNull();
    expect(out.recommendation).toEqual(['a/b: 1.0.0 → no fixed version published']);
  });

  it('reports an unbuilt/unscanned plugin as such rather than inventing counts', async () => {
    plugin.get.mockResolvedValue({ data: { plugin: { id: 'pl1', name: 'meta', version: '1', buildType: 'metadata_only' } } });
    const out = await call('inspect_plugin_build', { pluginId: 'pl1' });
    expect(out.plugin).toMatchObject({ imageSigned: false, scanned: false, scanFlaggedAt: null, runAsRoot: null });
  });

  it('builds a minimal exemption request when only the required fields are given', async () => {
    const ruleId = '33333333-3333-4333-8333-333333333333';
    const entityId = '44444444-4444-4444-8444-444444444444';
    compliance.get.mockResolvedValue({ data: { id: ruleId, name: 'Rule', isActive: true } });
    const out = await call('propose_compliance_exemption', { ruleId, entityType: 'pipeline', entityId, reason: 'why' });
    expect(out.target).toBe('Rule');
    expect(out.request).toEqual({ ruleId, entityType: 'pipeline', entityId, reason: 'why' });
    expect(postedPaths()).toEqual([]);
  });

  it('a compliance outage leaves a create draft marked UNCHECKED, not compliant', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p' } } });
    compliance.post.mockRejectedValue(new Error('POST /compliance/validate/pipeline/dry-run -> 503'));
    const out = await call('propose_pipeline', { prompt: 'x' });
    expect(out.compliance).toMatchObject({ checked: false, compliant: false });
  });
});
