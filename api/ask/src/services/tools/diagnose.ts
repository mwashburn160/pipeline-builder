// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PHASE 1 — diagnosis. Six READ tools, every one of them a GET (or a cached
 * report read) through the CALLER'S OWN forwarded token, so each owning service
 * re-checks the caller's permissions and tenancy exactly as it would for the
 * user's own dashboard request.
 *
 * ONE leg departs from that, deliberately: `diagnose_notifications` reads the
 * instance-wide outbound-email switch from platform's internal status route on
 * ASK's service identity (`readInstanceEmailStatus`), because that route is the
 * authoritative source and it is service-only. It returns a single boolean about
 * the INSTANCE — no tenant, no recipient, no provider — so no user's permissions
 * or tenancy are bypassed by reading it, and ask is not a caller of the send
 * route, so the same identity cannot make the instance send anything.
 *
 * Design rule 5 governs every return value here: these tools SHAPE, they do not
 * dump. No recipient address, no webhook URL (not even a masked one), no raw
 * downstream error body ever enters the model's context, because anything in
 * that context can surface in the assistant's prose or in a later tool call.
 * Counts, booleans and states carry the whole diagnostic signal.
 *
 * Several of these reads are gated on a capability the asking member may not
 * hold (the plugin build queue needs `plugins:write`; DORA needs the
 * `advanced_reporting` entitlement). Those are `settle`d: an unavailable leg is
 * REPORTED as unavailable rather than failing the turn, so a member still gets
 * the half they are entitled to see.
 */

import { tool } from '@pipeline-builder/ai-core';
import type { ToolSet } from '@pipeline-builder/ai-core';
import { z } from 'zod';

import type { AgentToolDeps } from '../tool-deps.js';
import { ResourceId } from '../tool-deps.js';
import { asArray, asRecord, settle, unwrap } from '../tool-helpers.js';

/** How many rows any one diagnosis returns. A card lists; it does not page. */
const MAX_ROWS = 20;

/** An optional ISO-8601 instant the model may supply for a report window. */
const IsoInstant = z.string().datetime().describe('ISO-8601 timestamp');

/** `true` when a value is a non-empty string — the "is this configured?" test. */
const isSet = (v: unknown): boolean => typeof v === 'string' && v.length > 0;

export function diagnoseTools(deps: AgentToolDeps): ToolSet {
  const { pipeline, plugin, platform, reporting, quota, emailStatus } = deps;

  return {
    inspect_pipeline_run: tool({
      description:
        'Explain why a pipeline run failed: its recent executions with the failing STAGE and ACTION for each, '
        + "plus the org's worst-offending stages and actions for context. Use it whenever the user asks why a "
        + 'build/deploy failed or what broke. Read-only.',
      inputSchema: z.object({
        pipelineId: ResourceId.describe('The pipeline id (from list_pipelines)'),
        executionId: z.string().max(128).optional().describe('Narrow to one execution id, if the user named one'),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe('How many recent executions to read'),
      }),
      execute: async ({ pipelineId, executionId, limit }) => {
        const size = limit ?? 10;
        const [runs, stages, actions] = await Promise.all([
          settle(async () => unwrap<{ executions?: unknown[] }>(
            await reporting.get(`/reports/execution/list?pipelineId=${encodeURIComponent(pipelineId)}&limit=${size}`),
          )),
          settle(async () => unwrap<{ stages?: unknown[] }>(await reporting.get('/reports/execution/stage-failures'))),
          settle(async () => unwrap<{ actions?: unknown[] }>(await reporting.get('/reports/execution/action-failures'))),
        ]);

        if (!runs.ok) return { pipelineId, unavailable: runs.reason };

        let executions = asArray(runs.value?.executions).map((e) => {
          const r = asRecord(e);
          return {
            executionId: r.executionId,
            status: r.status,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            durationMs: r.durationMs,
            failingStage: r.failingStage ?? null,
            failingAction: r.failingAction ?? null,
          };
        });
        if (executionId) executions = executions.filter((e) => e.executionId === executionId);

        const failed = executions.filter((e) => e.status === 'failed');
        return {
          pipelineId,
          executions: executions.slice(0, MAX_ROWS),
          summary: {
            read: executions.length,
            failed: failed.length,
            // The single most common failing stage across the runs read — the
            // first thing to look at, named rather than left to the model to
            // infer from the list.
            mostCommonFailingStage: topOf(failed.map((e) => e.failingStage)),
            mostCommonFailingAction: topOf(failed.map((e) => e.failingAction)),
          },
          orgStageFailures: stages.ok ? asArray(stages.value?.stages).slice(0, MAX_ROWS) : { unavailable: stages.reason },
          orgActionFailures: actions.ok ? asArray(actions.value?.actions).slice(0, MAX_ROWS) : { unavailable: actions.reason },
        };
      },
    }),

    inspect_plugin_build: tool({
      description:
        'Explain why a plugin build failed or what state it is in: the stored version (build/scan state, '
        + 'vulnerability counts, scan flag), the failed build-queue jobs with their error, and the failure '
        + 'triage buckets. Plugin creation is ASYNCHRONOUS — this is how you find out what happened after. '
        + 'Read-only. The queue legs need `plugins:write`; without it they report as unavailable.',
      inputSchema: z.object({
        pluginId: ResourceId.optional().describe('A specific plugin id, when the user named one'),
      }),
      execute: async ({ pluginId }) => {
        const [record, failed, triage] = await Promise.all([
          pluginId
            ? settle(async () => unwrap<{ plugin?: unknown }>(await plugin.get(`/plugins/${encodeURIComponent(pluginId)}`)))
            : Promise.resolve(null),
          settle(async () => unwrap<{ jobs?: unknown[] }>(await plugin.get(`/plugins/queue/failed?limit=${MAX_ROWS}`))),
          settle(async () => unwrap<{ categories?: unknown[]; groups?: unknown[] }>(await plugin.get('/plugins/queue/triage'))),
        ]);

        return {
          ...(pluginId ? { pluginId } : {}),
          plugin: record === null ? undefined
            : record.ok ? shapeBuiltPlugin(record.value?.plugin ?? record.value)
              : { unavailable: record.reason },
          failedJobs: failed.ok
            ? asArray(failed.value?.jobs).slice(0, MAX_ROWS).map((j) => {
              const r = asRecord(j);
              return {
                jobId: r.id,
                pluginName: r.pluginName,
                version: r.version,
                error: r.error,
                attemptsMade: r.attemptsMade,
                maxAttempts: r.maxAttempts,
                failedAt: r.failedAt,
              };
            })
            : { unavailable: failed.reason },
          triage: triage.ok ? triage.value : { unavailable: triage.reason },
        };
      },
    }),

    diagnose_notifications: tool({
      description:
        "Explain why the organization's notifications are or are not being delivered. Correlates the org's own "
        + 'settings (alert destinations, plugin security notices, compliance notices) against the PLATFORM-WIDE '
        + 'email switch that silently governs all of them. Use it for "we configured notifications and nothing '
        + 'arrives". Read-only, and it returns no addresses and no webhook URLs — only whether each is set. '
        + 'The email switch reads `enabled`, `disabled` or `unknown` — `unknown` means it could not be read and '
        + 'must NEVER be reported as disabled.',
      inputSchema: z.object({}),
      execute: async () => {
        const [authoritative, instance, destinations, pluginPrefs, compliancePrefs] = await Promise.all([
          // THE authoritative source: platform's own
          // `GET /internal/notify-email/status`, read with ask's SERVICE token
          // (see `readInstanceEmailStatus`). Never throws; `unknown` when it
          // could not be asked.
          emailStatus(),
          // Platform's PUBLIC `/config` — still read for `billingEnabled`, and
          // it carries the same switch as `serviceFeatures.email`. It is the
          // SECONDARY source for email: used only when the authoritative read
          // failed, and always labelled as such in the answer below.
          settle(async () => unwrap<{ serviceFeatures?: Record<string, unknown> }>(await platform.get('/config'))),
          settle(async () => unwrap<{ destinations?: unknown[] }>(await platform.get('/observability/alert-destinations'))),
          settle(async () => unwrap<Record<string, unknown>>(await plugin.get('/plugins/security-notifications'))),
          settle(async () => unwrap<Record<string, unknown>>(await deps.compliance.get('/compliance/notification-preferences'))),
        ]);

        // Which source actually answered, so a reader can tell an AUTHORITATIVE
        // "disabled" from one inferred off the public config — and so that
        // "could not determine" never reads as "off".
        const configured = instance.ok ? asRecord(instance.value?.serviceFeatures).email : undefined;
        const inferred = configured === true ? 'enabled' : configured === false ? 'disabled' : 'unknown';
        const email = authoritative !== 'unknown'
          ? { state: authoritative, source: 'platform internal status route' }
          : inferred !== 'unknown'
            ? { state: inferred, source: 'platform public /config (INFERRED — the authoritative read failed)' }
            : { state: 'unknown' as const, source: 'none — neither source answered' };

        const dests = destinations.ok
          ? asArray(unwrapList(destinations.value, 'destinations')).map((d) => {
            const r = asRecord(d);
            // Channel + state only. `target` is masked by the API and is STILL
            // withheld: a Slack incoming-webhook URL is bearer-equivalent and
            // has no place in a model's context.
            return { channel: r.channel ?? r.type, enabled: r.enabled !== false, minSeverity: r.minSeverity ?? null };
          })
          : null;

        const sec = pluginPrefs.ok ? asRecord(unwrapList(pluginPrefs.value, 'preferences')) : null;
        const comp = compliancePrefs.ok ? asRecord(unwrapList(compliancePrefs.value, 'preference')) : null;
        const external = sec ? asRecord(sec.externalEmail) : {};

        const emailChannels: string[] = [];
        if (dests?.some((d) => d.channel === 'email' && d.enabled)) emailChannels.push('alert destination');
        if (comp?.emailEnabled === true) emailChannels.push('compliance notifications');
        if (sec && Object.keys(external).length > 0) emailChannels.push('plugin security external address');

        return {
          platform: {
            // A STATE, never a value: `enabled` / `disabled` / `unknown`.
            email: email.state,
            emailSource: email.source,
            emailAuthoritative: authoritative !== 'unknown',
            ...(instance.ok
              ? { billingEnabled: asRecord(instance.value?.serviceFeatures).billing === true }
              : { configUnavailable: instance.reason }),
          },
          alertDestinations: dests
            ? { count: dests.length, byChannel: countBy(dests.map((d) => String(d.channel ?? 'unknown'))), destinations: dests.slice(0, MAX_ROWS) }
            : { unavailable: destinations.ok ? 'no data' : destinations.reason },
          pluginSecurityNotifications: sec
            ? {
              recipientMode: sec.recipientMode,
              recipientCount: asArray(sec.targetUsers).length,
              notifyRescan: sec.notifyRescan,
              digestMode: sec.digestMode,
              hasWebhook: isSet(sec.webhookUrl),
              hasWebhookSecret: sec.hasWebhookSecret === true,
              externalAddress: Object.keys(external).length === 0
                ? 'not configured'
                : external.verified === true ? 'verified' : 'pending confirmation',
            }
            : { unavailable: pluginPrefs.ok ? 'no data' : pluginPrefs.reason },
          complianceNotifications: comp
            ? {
              notifyOnBlock: comp.notifyOnBlock,
              notifyOnWarning: comp.notifyOnWarning,
              emailEnabled: comp.emailEnabled,
              digestMode: comp.digestMode,
              recipientCount: comp.targetUsers === null ? 'all org admins' : asArray(comp.targetUsers).length,
              hasWebhook: isSet(comp.webhookUrl),
              hasWebhookSecret: comp.hasWebhookSecret === true,
            }
            : { unavailable: compliancePrefs.ok ? 'no data' : compliancePrefs.reason },
          // The whole point of the tool. THE trap documented in
          // docs/notifications.md: `EmailService.send` returns true when
          // EMAIL_ENABLED is not 'true', so every caller that surfaces an
          // "emailSent" flag reports success for a message never attempted.
          // Nothing in the org-facing UI shows the switch.
          finding: email.state === 'disabled' && emailChannels.length > 0
            ? {
              severity: 'blocking',
              summary: `Outbound email is DISABLED on this instance (EMAIL_ENABLED is not true), but ${emailChannels.length} email channel(s) are configured: ${emailChannels.join(', ')}.`,
              detail: 'A disabled send REPORTS SUCCESS: invitations answer 201 and verification says "sent", so nothing anywhere reports the drop. In-app messages and per-org Slack/HTTPS webhooks are unaffected — they do not go through email. Only an operator can turn it on; the diagnostic an org admin can run is Send test on an email alert destination, which reports "email-disabled".',
              source: email.source,
            }
            : email.state === 'disabled'
              ? { severity: 'info', summary: 'Outbound email is disabled on this instance, but no email channel is configured, so nothing is being silently dropped.', source: email.source }
              : email.state === 'enabled'
                ? { severity: 'info', summary: 'Outbound email is enabled on this instance, so the cause is not the instance switch.', source: email.source }
                // NOT "disabled". Reporting a switch we could not read as OFF
                // would send an admin to an operator to turn on something that
                // may already be on, while the real cause goes unlooked-at.
                : {
                  severity: 'unknown',
                  summary: 'Could NOT determine whether outbound email is enabled on this instance — neither platform\'s internal status route nor its public config answered. This is not the same as disabled: do not tell the user email is off.',
                  detail: 'Every other part of this report was still read. Re-run the diagnosis, and treat a platform that could not be reached as a fault of its own to chase.',
                  source: email.source,
                },
        };
      },
    }),

    diagnose_installs: tool({
      description:
        "Audit the organization's plugin installs against published advisories and scan flags: which installs "
        + 'resolve to a flagged or advised version, and the smallest upgrade that clears each one. Use it for '
        + '"are we exposed?" and "what should we upgrade?". Read-only.',
      inputSchema: z.object({}),
      execute: async () => {
        const res = await settle(async () => unwrap<{ installs?: unknown[]; policy?: unknown }>(await plugin.get('/plugins/installs')));
        if (!res.ok) return { unavailable: res.reason };

        const installs = asArray(res.value?.installs).map((i) => {
          const r = asRecord(i);
          const advisories = asArray(r.advisories).map((a) => asRecord(a));
          const warnings = asArray<string>(r.warnings);
          // The smallest version that clears every advisory covering this
          // resolution: the highest `fixedVersion` among them (an advisory with
          // no fix contributes none, and leaves `clearedBy` null).
          const fixes = advisories.map((a) => a.fixedVersion).filter((v): v is string => typeof v === 'string');
          return {
            id: r.id,
            listing: `${r.publisherHandle}/${r.name}`,
            versionPolicy: r.versionPolicy,
            pinnedVersion: r.pinnedVersion ?? null,
            resolvedVersion: r.resolvedVersion ?? null,
            latestVersion: r.latestVersion ?? null,
            status: r.status,
            blocked: r.blocked ?? null,
            warnings,
            advisories: advisories.map((a) => ({ id: a.id, severity: a.severity, summary: a.summary, fixedVersion: a.fixedVersion ?? null, blocking: a.blocking === true })),
            upgrade: r.upgrade ?? null,
            clearedBy: fixes.length ? fixes.sort(compareVersions).at(-1) ?? null : null,
            // An approval-gated install cannot simply be PATCHed by this member;
            // propose_install_change files it into the org's approval queue.
            needsApproval: r.needsApproval === true,
          };
        });

        const exposed = installs.filter((i) => i.advisories.length > 0 || i.blocked);
        return {
          total: installs.length,
          exposed: exposed.length,
          installs: exposed.length ? exposed.slice(0, MAX_ROWS) : installs.slice(0, MAX_ROWS),
          // Named so the model does not have to derive it (and get it wrong).
          recommendation: exposed.length === 0
            ? 'No install resolves to a version carrying a published advisory.'
            : exposed
              .map((i) => `${i.listing}: ${i.resolvedVersion ?? 'unresolved'} → ${i.clearedBy ?? i.upgrade ?? 'no fixed version published'}`)
              .slice(0, MAX_ROWS),
        };
      },
    }),

    check_quota_headroom: tool({
      description:
        "Read the organization's quota headroom: per-dimension limit, used, remaining and when the period "
        + 'resets. Quotas are per-period FLOW counters, not stock — deleting a pipeline does not give a slot '
        + 'back. Use it before proposing anything that consumes quota, and to explain a 429. Read-only.',
      inputSchema: z.object({}),
      execute: async () => {
        // No orgId input: `GET /quotas` resolves the org from the forwarded
        // token, so this can only ever read the authenticated org's headroom.
        const res = await settle(async () => unwrap<{ quota?: unknown }>(await quota.get('/quotas')));
        if (!res.ok) return { unavailable: res.reason };
        const q = asRecord(res.value?.quota ?? res.value);
        const quotas = asRecord(q.quotas);
        const dims = Object.entries(quotas).map(([type, v]) => {
          const s = asRecord(v);
          return {
            type,
            limit: s.limit,
            used: s.used,
            remaining: s.remaining,
            unlimited: s.unlimited === true || s.limit === -1,
            resetAt: s.resetAt ?? null,
          };
        });
        return {
          tier: q.tier,
          quotas: dims,
          // The dimensions actually at risk, so the model does not have to do
          // arithmetic to answer "are we about to run out?".
          atRisk: dims.filter((d) => !d.unlimited && typeof d.remaining === 'number' && typeof d.limit === 'number'
            && d.limit > 0 && d.remaining <= d.limit * 0.1).map((d) => d.type),
        };
      },
    }),

    inspect_dora_drivers: tool({
      description:
        "Read the organization's DORA metrics (deployment frequency, lead time, change failure rate, MTTR) "
        + 'together with the things that DRIVE them: the trend, the worst stages and actions, and build health. '
        + 'Use it for "why is our lead time bad?" or "are we getting better?". Read-only. DORA needs the '
        + '`advanced_reporting` entitlement; without it the DORA legs report as unavailable and the rest still returns.',
      inputSchema: z.object({
        from: IsoInstant.optional().describe('Window start'),
        to: IsoInstant.optional().describe('Window end'),
        pipelineId: ResourceId.optional().describe('Restrict to one pipeline'),
        environment: z.string().max(64).optional().describe('Restrict to one deploy environment'),
      }),
      execute: async ({ from, to, pipelineId, environment }) => {
        const params = new URLSearchParams();
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (pipelineId) params.set('pipelineId', pipelineId);
        if (environment) params.set('environment', environment);
        const qs = params.toString() ? `?${params.toString()}` : '';

        const [dora, trend, stages, actions, health] = await Promise.all([
          settle(async () => unwrap<unknown>(await reporting.get(`/reports/execution/dora${qs}`))),
          settle(async () => unwrap<unknown>(await reporting.get(`/reports/execution/dora/trend${qs}`))),
          settle(async () => unwrap<{ stages?: unknown[] }>(await reporting.get('/reports/execution/stage-failures'))),
          settle(async () => unwrap<{ actions?: unknown[] }>(await reporting.get('/reports/execution/action-failures'))),
          settle(async () => unwrap<unknown>(await reporting.get('/reports/execution/build-health'))),
        ]);

        return {
          window: { from: from ?? null, to: to ?? null, pipelineId: pipelineId ?? null, environment: environment ?? null },
          dora: dora.ok ? dora.value : { unavailable: dora.reason },
          trend: trend.ok ? trend.value : { unavailable: trend.reason },
          drivers: {
            stageFailures: stages.ok ? asArray(stages.value?.stages).slice(0, MAX_ROWS) : { unavailable: stages.reason },
            actionFailures: actions.ok ? asArray(actions.value?.actions).slice(0, MAX_ROWS) : { unavailable: actions.reason },
            buildHealth: health.ok ? health.value : { unavailable: health.reason },
          },
        };
      },
    }),

    list_pipelines: tool({
      description: "List the current organization's existing pipelines, to reason about what is already there.",
      inputSchema: z.object({}),
      execute: async () => {
        const res = (await pipeline.get('/pipelines')) as { data?: unknown };
        return { pipelines: res?.data ?? res };
      },
    }),

    inspect_pipeline: tool({
      description: 'Fetch one pipeline by id to inspect its configuration before answering or proposing changes.',
      inputSchema: z.object({ id: ResourceId.describe('The pipeline id') }),
      execute: async ({ id }) => {
        const res = (await pipeline.get(`/pipelines/${encodeURIComponent(id)}`)) as { data?: unknown };
        return { pipeline: res?.data ?? res };
      },
    }),
  };
}

/** Some services nest their single object one level deeper; accept either. */
function unwrapList(value: unknown, key: string): unknown {
  const rec = asRecord(value);
  return key in rec ? rec[key] : value;
}

/** The most frequent non-null entry, or null. */
function topOf(values: unknown[]): unknown {
  const counts = countBy(values.filter((v) => v !== null && v !== undefined).map(String));
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return top ? top[0] : null;
}

/** Frequency map. */
function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Numeric-segment version compare, so `1.10.0` sorts above `1.9.0`. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (!Number.isNaN(d) && d !== 0) return d;
  }
  return a.localeCompare(b);
}

/**
 * The build/supply-chain facts of a stored plugin version. Deliberately narrow:
 * the full row carries the Dockerfile, every command and the README, none of
 * which explains a build outcome.
 */
function shapeBuiltPlugin(value: unknown): Record<string, unknown> {
  const p = asRecord(value);
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    buildType: p.buildType,
    isActive: p.isActive,
    imageSigned: isSet(p.imageDigest),
    imageSource: p.imageSource ?? null,
    scanned: p.scannedAt !== null && p.scannedAt !== undefined,
    scannedAt: p.scannedAt ?? null,
    vulnerabilities: {
      critical: p.vulnCritical ?? null,
      high: p.vulnHigh ?? null,
      criticalFixable: p.vulnCriticalFixable ?? null,
      highFixable: p.vulnHighFixable ?? null,
    },
    scanFlaggedAt: p.scanFlaggedAt ?? null,
    scanFlag: p.scanFlag ?? null,
    runAsRoot: p.runAsRoot ?? null,
    yankedAt: p.yankedAt ?? null,
    deprecatedAt: p.deprecatedAt ?? null,
  };
}
