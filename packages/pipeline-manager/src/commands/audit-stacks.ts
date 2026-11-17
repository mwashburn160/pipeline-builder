// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { Command } from 'commander';
import { decodeTokenPayload } from '../utils/auth-guard.js';
import { applyAwsProfile, resolveAwsRegion } from '../utils/aws-env.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withRegionOption, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, reportError, ValidationError } from '../utils/error-handler.js';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { extractListPage } from '../utils/response-utils.js';

/** One `GET /api/pipelines/registry` row (the fields this audit reads). */
export interface RegistryEntry {
  /** Registry row UUID — what `pipeline deregister --id` takes. */
  id: string;
  pipelineId: string;
  orgId?: string;
  pipelineName: string;
  stackName?: string;
  region?: string;
}

interface StackInfo {
  stackName: string;
  stackStatus: string;
  region: string;
  pipelineBuilderTag?: string;
  orgIdTag?: string;
  pipelineIdTag?: string;
  creationTime?: Date;
}

export interface AuditFinding {
  type: 'orphaned-stack' | 'missing-stack';
  stackName?: string;
  pipelineId?: string;
  pipelineName?: string;
  /** Registry row id (missing-stack only). */
  registryId?: string;
  detail: string;
  /** The command that reconciles this finding. */
  fix: string;
}

const ACTIVE_STATUSES = [
  'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE',
];

/** Registry rows fetched per request (the route caps `limit` at MAX_PAGE_LIMIT, 1000 by default). */
export const REGISTRY_PAGE_LIMIT = 500;

/** Default backstop on CloudFormation DescribeStacks pages (~100 stacks per page). */
const DEFAULT_MAX_STACK_PAGES = 200;

/**
 * Read EVERY registry row the platform returns for this caller (`limit` +
 * `offset` paging until `pagination.hasMore` is false). A partial registry is
 * as bad as an empty one: each row left unread becomes a false orphaned-stack
 * finding. `orgId` is sent when `--org` names an org — the platform scopes the
 * list to the caller's org unless it honours that parameter (a system-org
 * caller), and the caller checks which org it got back.
 */
export async function fetchAllRegistryEntries(
  client: { get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> },
  pipelineUrl: string,
  orgId?: string,
): Promise<RegistryEntry[]> {
  const entries: RegistryEntry[] = [];
  // Advance by the rows actually RETURNED, not the limit asked for: the server
  // clamps `limit` to its own MAX_PAGE_LIMIT, and stepping by 500 over smaller
  // pages skipped rows — each one a false orphaned-stack finding.
  for (let offset = 0; ;) {
    const res = await client.get(`${pipelineUrl}/registry`, {
      limit: REGISTRY_PAGE_LIMIT,
      offset,
      ...(orgId ? { orgId } : {}),
    });
    const page = extractListPage<RegistryEntry>(res, 'registry');
    entries.push(...page.items);
    offset += page.items.length;
    // An empty page ends the walk even if the server claims more, so a
    // misreporting server can't spin this forever.
    if (!page.hasMore || page.items.length === 0) return entries;
  }
}

/**
 * Registers the `audit-stacks` command with the CLI program.
 *
 * Diffs CloudFormation stacks (filtered to those tagged with `pipeline-builder`)
 * against the platform's `pipeline_registry` table. Surfaces:
 *   - **Orphaned stacks**: tagged stacks with no DB record (likely leftovers after
 *     a pipeline was deleted from the dashboard but the CDK stack stayed in AWS).
 *   - **Missing stacks**: registry entries pointing to stacks that no longer exist
 *     in CloudFormation (likely after a manual `aws cloudformation delete-stack`).
 *
 * Scope: the registry of ONE org (yours, or `--org` when the platform lets the
 * credential list that org) against the stacks of ONE region (`--region`) —
 * registry rows of other regions are counted but not compared, and stacks
 * tagged with another `OrgId` are skipped. Every finding carries the command
 * that reconciles it (`pipeline deregister` for a missing stack; `pipeline
 * register` or `aws cloudformation delete-stack` for an orphaned one).
 *
 * Designed for cron use:
 *   - Exits 0 when there are no findings.
 *   - Exits 1 when at least one orphaned or missing stack is found.
 *   - Exits 2 on AWS errors / scan failures.
 *
 * @example
 * ```bash
 * pipeline-manager audit stacks --region us-east-1
 * pipeline-manager audit stacks --region eu-west-1 --json
 * ```
 */
export function auditStacks(program: Command): void {
  withSslOptions(
    withProfileOption(
      withRegionOption(program
        .command('stacks')
        .description('Diff CloudFormation stacks vs pipeline_registry to find orphaned or missing CDK deployments')),
    )
      .option('--org <orgId>', 'Audit this org (default: your own). Another org needs a credential the platform lets list it')
      .option('--max-pages <n>', 'Safety cap on CloudFormation DescribeStacks pages (~100 stacks each)', String(DEFAULT_MAX_STACK_PAGES))
      .option('--json', 'Output results as JSON', false),
  )
    .action(async (options) => {
      const executionId = printCommandHeader('Audit Stacks', undefined, { quiet: options.json });
      printSslWarning(options.verifySsl);

      const region = resolveAwsRegion(options.region);
      // Honor --profile for the SDK CloudFormation client below (without this, the
      // scan always hit the default account and could diff the registry against
      // the WRONG account's stacks → bogus orphaned/missing findings).
      applyAwsProfile(options.profile);
      const maxPages = Number.parseInt(String(options.maxPages), 10);
      // Org ids are lowercase (the route lowercases `?orgId=` the same way).
      const requestedOrg: string | undefined = typeof options.org === 'string' && options.org.trim()
        ? options.org.trim().toLowerCase()
        : undefined;

      // Decided inside the try, exited on outside it: an exit inside would be
      // caught as a scan failure wherever process.exit throws (tests, embedders).
      let exitCode: number;
      try {
        if (!Number.isInteger(maxPages) || maxPages < 1) {
          throw new ValidationError('--max-pages must be a positive integer', 'max-pages', String(options.maxPages));
        }
        // Fetch the platform's view of registered pipelines.
        // Progress goes to stdout, so suppress it in --json mode to keep the JSON payload clean for piping.
        if (!options.json) printInfo('Fetching pipeline registry from platform', { org: options.org ?? '(your org)' });
        const client = await createAuthenticatedClientAsync(options);
        const allEntries = await fetchAllRegistryEntries(client, client.getConfig().api.pipelineUrl, requestedOrg);

        // Which org this audit is about. `--org` is a request; the rows say what
        // the platform actually answered for. A platform that scoped the list to
        // the caller's own org instead would make every stack of the requested
        // org read as orphaned — so a mismatch is an error, not a finding.
        const answeredFor = new Set(allEntries.map((e) => e.orgId).filter((o): o is string => !!o));
        if (requestedOrg && [...answeredFor].some((o) => o !== requestedOrg)) {
          throw new ValidationError(
            `The platform returned the registry of ${[...answeredFor].join(', ')}, not --org ${requestedOrg}. `
            + 'Auditing another org needs a credential the platform lets list that org\'s registry.',
            'org',
            requestedOrg,
          );
        }
        const auditOrg: string | undefined = requestedOrg
          ?? (answeredFor.size === 1 ? [...answeredFor][0] : undefined)
          ?? decodeTokenPayload(process.env.PLATFORM_TOKEN ?? '')?.organizationId;

        // The scan below covers ONE region, so only that region's rows can be
        // compared — every other region's pipeline would otherwise be "missing".
        // A row with no region can't be placed, so it is counted and left out.
        const entries = allEntries.filter((e) => e.region === region);
        const withoutRegion = allEntries.filter((e) => !e.region).length;
        if (withoutRegion > 0 && !options.json) {
          printWarning(`${withoutRegion} registry entr${withoutRegion === 1 ? 'y has' : 'ies have'} no region and ${withoutRegion === 1 ? 'is' : 'are'} not compared — re-register with "pipeline-manager pipeline register --id <pipelineId> --region <region>"`);
        }
        if (!auditOrg && !options.json) {
          printWarning('Could not tell which org this credential belongs to — stacks of every org in the account are compared');
        }

        // Fetch stacks from CloudFormation. DescribeStacks (no StackName) returns every
        // active stack WITH its tags in one paginated sweep — avoiding the N+1
        // DescribeStacks-per-stack a ListStacks path needs (ListStacks omits tags)
        // and the API throttling that causes on accounts with many stacks.
        if (!options.json) printInfo('Listing CloudFormation stacks', { region });
        const cfn = new CloudFormationClient({ region });
        const stacks: StackInfo[] = [];
        // Every stack that EXISTS, whatever its state or tags. A registry row is
        // only `missing-stack` when its stack is gone: one mid-update
        // (UPDATE_IN_PROGRESS) or stuck in a failed rollback still exists, and
        // reporting it missing told the operator to deregister a live pipeline.
        const existingStackNames = new Set<string>();
        const activeStatuses = new Set(ACTIVE_STATUSES);
        let nextToken: string | undefined;
        let pages = 0;
        // Backstop only (~20k stacks at ~100/page), not an expected limit. A FULL scan
        // matters: truncating would diff the registry against an incomplete stack set and
        // report live stacks as `missing-stack`. So if this is ever hit, warn LOUDLY rather
        // than silently under-reporting (the previous code capped at 20 pages silently).
        let truncated = false;
        do {
          const resp = await cfn.send(new DescribeStacksCommand({ NextToken: nextToken }));
          for (const stack of resp.Stacks ?? []) {
            if (!stack.StackName) continue;
            if (stack.StackStatus !== 'DELETE_COMPLETE') existingStackNames.add(stack.StackName);
            if (!activeStatuses.has(stack.StackStatus ?? '')) continue; // skip in-progress/rolled-back/deleted
            const tags = stack.Tags ?? [];
            const pbTag = tags.find((t) => t.Key === 'pipeline-builder')?.Value;
            const orgTag = tags.find((t) => t.Key === 'OrgId')?.Value;
            if (!pbTag) continue; // Not a pipeline-builder stack.
            // Another org's stack in the same account is not this org's drift.
            if (auditOrg && orgTag && orgTag.toLowerCase() !== auditOrg.toLowerCase()) continue;
            stacks.push({
              stackName: stack.StackName,
              stackStatus: stack.StackStatus ?? 'UNKNOWN',
              region,
              pipelineBuilderTag: pbTag,
              orgIdTag: orgTag,
              pipelineIdTag: tags.find((t) => t.Key === 'pb.pipeline-id')?.Value,
              creationTime: stack.CreationTime,
            });
          }
          nextToken = resp.NextToken;
          pages++;
          if (nextToken && pages >= maxPages) { truncated = true; break; }
        } while (nextToken);
        if (truncated) {
          printWarning(`Stack scan hit the ${maxPages}-page safety cap — results may be INCOMPLETE and 'missing-stack' findings could be false. Raise --max-pages.`);
        }

        // Diff.
        const registryStackNames = new Set(entries.map((e) => e.stackName).filter((n): n is string => !!n));

        const findings: AuditFinding[] = [];
        for (const stack of stacks) {
          if (!registryStackNames.has(stack.stackName)) {
            findings.push({
              type: 'orphaned-stack',
              stackName: stack.stackName,
              ...(stack.pipelineIdTag ? { pipelineId: stack.pipelineIdTag } : {}),
              detail: `CloudFormation stack tagged pipeline-builder=${stack.pipelineBuilderTag ?? '(unset)'} has no matching pipeline_registry entry`,
              // Still wanted → register it; a leftover → delete the stack.
              fix: stack.pipelineIdTag
                ? `pipeline-manager pipeline register --id ${stack.pipelineIdTag} --region ${region}   # or, if unwanted: aws cloudformation delete-stack --stack-name ${stack.stackName} --region ${region}`
                : `aws cloudformation delete-stack --stack-name ${stack.stackName} --region ${region}`,
            });
          }
        }
        for (const entry of entries) {
          if (entry.stackName && !existingStackNames.has(entry.stackName)) {
            findings.push({
              type: 'missing-stack',
              stackName: entry.stackName,
              pipelineId: entry.pipelineId,
              pipelineName: entry.pipelineName,
              registryId: entry.id,
              detail: `Registry entry references stack ${entry.stackName} but no such stack exists in CloudFormation (${region})`,
              fix: `pipeline-manager pipeline deregister --id ${entry.id}`,
            });
          }
        }

        // A truncated (incomplete) scan is a finding in itself: it can both miss
        // real drift AND emit false missing-stack findings, so it must exit
        // non-zero and be visible in the JSON (mirrors audit-tokens).
        exitCode = (findings.length > 0 || truncated) ? 1 : 0;

        if (options.json) {
          console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            region,
            org: auditOrg,
            registryEntries: entries.length,
            registryEntriesOtherRegions: allEntries.length - entries.length - withoutRegion,
            registryEntriesWithoutRegion: withoutRegion,
            cfnStacks: stacks.length,
            truncated,
            findings,
            executionId,
          }, null, 2));
        } else {
          printSection('Audit Results');
          printInfo('Counts', {
            region,
            registryEntries: String(entries.length),
            registryEntriesOtherRegions: String(allEntries.length - entries.length - withoutRegion),
            cfnStacks: String(stacks.length),
            findings: String(findings.length),
          });
          if (findings.length === 0) {
            printSuccess('No drift between pipeline_registry and CloudFormation');
          } else {
            for (const f of findings) {
              if (f.type === 'orphaned-stack') {
                printWarning(`ORPHANED  ${f.stackName} — ${f.detail}`);
              } else {
                printWarning(`MISSING   ${f.stackName} (pipeline ${f.pipelineId ?? '?'}) — ${f.detail}`);
              }
              console.log(`          fix: ${f.fix}`);
            }
            printError(`${findings.length} drift finding${findings.length === 1 ? '' : 's'} — each is listed with the command that reconciles it.`);
          }
        }
      } catch (error) {
        reportError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          context: { command: 'audit-stacks', executionId },
        });
        exitCode = 2;
      }
      process.exit(exitCode);
    });
}
