// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline-manager report …` — the stakeholder-report add-on from a terminal.
 *
 * Six verbs, matching the API surface a lead actually drives: `create`, `list`,
 * `run --period`, `publish`, `link` and `transfer`.
 *
 * WHY A CLI FOR THIS AT ALL. Two jobs the dashboard is the wrong shape for. The first is
 * BACKFILL: `report run --period 2026-W34` for each of five weeks is a loop in a shell and
 * five careful clicks in a browser. The second is UNATTENDED OPERATION — a team that wants
 * its report produced by its own scheduler rather than ours, or wants publishing gated on a
 * release finishing, needs a command with an exit code.
 *
 * EVERY GATE IS THE SERVER'S. The CLI checks nothing: `reports:author` for create and run,
 * `reports:share` for publish and link, the `stakeholder_reports` feature for all of them,
 * and the org's admin-owned policy for whether a link may be minted at all. The caller's
 * token decides, and a 403 is printed as the server worded it — a CLI that pre-judged
 * would be a second copy of the rules, wrong the first time either changed.
 */

import { Command } from 'commander';
import pico from 'picocolors';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';

const { bold, dim, green, yellow } = pico;

/** The API shape the CLI reads. Narrowed to what it prints. */
interface ReportDefinition {
  id: string;
  name: string;
  template: string;
  cadence: string;
  timezone: string;
  weekStart: string;
  isActive: boolean;
  pausedReason?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  recipients: string[];
  autoSend: boolean;
}

interface ReportRun {
  id: string;
  periodLabel: string;
  version: number;
  status: string;
  publishedAt?: string | null;
}

const BASE = '/api/reports/stakeholder';

/** The response envelope every route here returns. */
interface Envelope<T> { success?: boolean; data?: T; message?: string }

/** Unwrap an envelope, or fail with the server's own words. */
function unwrap<T>(response: unknown, what: string): T {
  const env = response as Envelope<T> | undefined;
  if (!env || env.success === false || !env.data) {
    throw new Error(env?.message ?? `The server returned no ${what}`);
  }
  return env.data;
}

export function report(program: Command): void {
  const group = program.command('report').description('Create, run, publish and share stakeholder reports');

  // ── list ──────────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('list')
    .description('List this organization\'s saved reports, their schedule and pause state.'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report List');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const start = Date.now();
        const data = unwrap<{ definitions: ReportDefinition[] }>(
          await client.get(`${client.getConfig().api.baseUrl}${BASE}/definitions`), 'reports',
        );
        printSection('Saved Reports');
        if (data.definitions.length === 0) {
          printInfo('No saved reports yet. Create one with `pipeline-manager report create`.');
        }
        for (const d of data.definitions) {
          // The pause REASON, not just the state: "paused" on its own is a support ticket.
          const state = d.isActive
            ? green('active')
            : yellow(`paused${d.pausedReason ? ` (${d.pausedReason})` : ''}`);
          printKeyValue({
            [bold(d.name)]: `${state} ${dim(`· ${d.cadence} · ${d.timezone} · ${d.recipients.length} recipient(s)${d.autoSend ? ' · auto-send' : ''}`)}`,
            '  id': d.id,
            '  next run': d.nextRunAt ?? '(not scheduled)',
            '  last run': d.lastRunAt ?? '(never)',
          });
        }
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-list', executionId },
        });
      }
    });

  // ── create ────────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('create')
    .description('Save a new scheduled report. The creator owns it; a scheduled run is authorized as the owner.')
    .requiredOption('-n, --name <name>', 'Report name, as its recipients will see it')
    .option('-t, --template <template>', 'weekly_delivery | monthly_health | quarterly_review', 'weekly_delivery')
    .option('-z, --timezone <tz>', 'IANA timezone the period is cut in (defaults to the server\'s report default)')
    .option('--week-start <day>', 'monday | sunday')
    .option('--scope <kind>', 'org | projects | rollup', 'org')
    .option('--projects <names>', 'Comma-separated project names (with --scope projects)')
    .option('--recipients <ids>', 'Comma-separated recipient IDs from the org\'s distribution list')
    .option('--auto-send', 'Publish without review. Off by default — the review step is where the context goes.'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report Create');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const projects = splitList(options.projects);
        if (options.scope === 'projects' && projects.length === 0) {
          throw new Error('--scope projects needs --projects with at least one project name');
        }
        const body: Record<string, unknown> = {
          name: options.name,
          template: options.template,
          scope: options.scope === 'projects' ? { kind: 'projects', projects } : { kind: options.scope },
          recipients: splitList(options.recipients),
          autoSend: options.autoSend === true,
          ...(options.timezone ? { timezone: options.timezone } : {}),
          ...(options.weekStart ? { weekStart: options.weekStart } : {}),
        };
        const start = Date.now();
        const data = unwrap<{ definition: ReportDefinition }>(
          await client.post(`${client.getConfig().api.baseUrl}${BASE}/definitions`, body), 'report',
        );
        printSection('Report Saved');
        printKeyValue({
          'Name': green(bold(data.definition.name)),
          'ID': data.definition.id,
          'Cadence': `${data.definition.cadence} · ${data.definition.timezone}`,
          'Next run': data.definition.nextRunAt ?? '(not scheduled)',
        });
        if (data.definition.recipients.length === 0) {
          // Said here because it is the most common way a new report reaches nobody: the
          // distribution list is per ORG and an address confirms by email before delivery.
          printWarning('No recipients yet — add them in the dashboard; an external address confirms by email before anything is delivered.');
        }
        printSuccess('Report created');
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-create', executionId },
        });
      }
    });

  // ── run ───────────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('run')
    .description('Compose one period into a frozen snapshot. Without --period, the last complete period.')
    .requiredOption('-i, --id <id>', 'Report definition ID')
    .option('-p, --period <label>', 'Period label: 2026-W38 (weekly), 2026-08 (monthly), 2026-Q3 (quarterly)')
    .option('--regenerate', 'Produce version N+1 instead of reusing an existing snapshot'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report Run');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const start = Date.now();
        const data = unwrap<{ run: ReportRun; reused?: boolean }>(
          await client.post(
            `${client.getConfig().api.baseUrl}${BASE}/definitions/${encodeURIComponent(options.id)}/runs`,
            {
              ...(options.period ? { period: options.period } : {}),
              ...(options.regenerate ? { regenerate: true } : {}),
            },
          ), 'run',
        );
        printSection(data.reused ? 'Existing Snapshot' : 'Snapshot Composed');
        printKeyValue({
          'Period': green(bold(data.run.periodLabel)),
          'Run ID': data.run.id,
          'Version': String(data.run.version),
          'Status': data.run.status,
        });
        if (data.reused) {
          // Not a no-op to hide: a frozen snapshot's numbers do not change, so re-running
          // returns what exists. `--regenerate` is how you ask for a new version.
          printInfo('This period already had a snapshot, so it was returned unchanged. Use --regenerate for a new version.');
        }
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-run', executionId },
        });
      }
    });

  // ── publish ───────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('publish')
    .description('Publish a composed run. Needs reports:share — publishing is when numbers leave the platform.')
    .requiredOption('-r, --run <id>', 'Run ID to publish'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report Publish');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const start = Date.now();
        const data = unwrap<{ run: ReportRun; alreadyPublished?: boolean }>(
          await client.post(
            `${client.getConfig().api.baseUrl}${BASE}/runs/${encodeURIComponent(options.run)}/publish`, {},
          ), 'run',
        );
        printSection('Published');
        printKeyValue({
          'Period': green(bold(data.run.periodLabel)),
          'Published at': data.run.publishedAt ?? '(unknown)',
        });
        if (data.alreadyPublished) {
          // Idempotent by design: two publishes send one report, so a retried script is
          // safe. Reported rather than silent, so a wrapper can tell the difference.
          printInfo('This run was already published; nothing was sent again.');
        } else {
          printSuccess('Published — delivery is under way');
        }
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-publish', executionId },
        });
      }
    });

  // ── link ──────────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('link')
    .description('Mint an expiring read-only link to a published run. The token is shown ONCE.')
    .requiredOption('-r, --run <id>', 'Published run ID')
    .option('--days <n>', 'Days until it expires (server default 30, maximum 180)')
    .option('--redact-names', 'Replace project and pipeline names in the shared view'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report Link');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const days = options.days === undefined ? undefined : Number(options.days);
        if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
          throw new Error('--days must be a positive whole number of days');
        }
        const start = Date.now();
        const data = unwrap<{ url?: string; token?: string; expiresAt: string }>(
          await client.post(
            `${client.getConfig().api.baseUrl}${BASE}/runs/${encodeURIComponent(options.run)}/links`,
            {
              ...(days !== undefined ? { expiresInDays: days } : {}),
              ...(options.redactNames ? { redactNames: true } : {}),
            },
          ), 'link',
        );
        printSection('Share Link');
        printKeyValue({
          Link: green(bold(data.url ?? data.token ?? '(not returned)')),
          Expires: data.expiresAt,
        });
        // Said every time, because it is true every time and the consequence is permanent:
        // the server stores only a hash, so a lost token cannot be recovered, only replaced.
        printWarning('Copy this now — only a hash is stored, so it cannot be shown again. Revoke it in the dashboard if it leaks.');
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-link', executionId },
        });
      }
    });

  // ── transfer ──────────────────────────────────────────────────────────────
  withSslOptions(group
    .command('transfer')
    .description('Hand a report to a new owner. A scheduled run is authorized AS the owner, so this is a privilege move.')
    .requiredOption('-i, --id <id>', 'Report definition ID')
    .requiredOption('-o, --owner <userId>', 'New owner\'s user ID — must be a live member of this org'))
    .action(async (options) => {
      const executionId = printCommandHeader('Report Transfer');
      try {
        printSslWarning(options.verifySsl);
        const client = createAuthenticatedClient(options);
        const start = Date.now();
        const data = unwrap<{ definition: ReportDefinition }>(
          await client.post(
            `${client.getConfig().api.baseUrl}${BASE}/definitions/${encodeURIComponent(options.id)}/transfer`,
            { ownerId: options.owner },
          ), 'report',
        );
        printSection('Ownership Transferred');
        printKeyValue({ 'Report': green(bold(data.definition.name)), 'New owner': options.owner });
        // The consequence, in one line: from now on the report computes with a different
        // person's access, which can change what it contains.
        printInfo('Future runs are authorized as the new owner, so the report now computes with their access.');
        printExecutionSummary(executionId, Date.now() - start);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'report-transfer', executionId },
        });
      }
    });
}

/** `"a, b ,c"` → `['a','b','c']`; empty or absent → `[]`. */
function splitList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
