// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CloudFormationClient, ListStacksCommand, DescribeStacksCommand, type StackStatus } from '@aws-sdk/client-cloudformation';
import { Command } from 'commander';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils';

interface RegistryEntry {
  pipelineId: string;
  pipelineArn: string;
  pipelineName: string;
  stackName?: string;
  accountId?: string;
  region?: string;
}

interface StackInfo {
  stackName: string;
  stackStatus: string;
  region: string;
  pipelineBuilderTag?: string;
  orgIdTag?: string;
  creationTime?: Date;
}

interface AuditFinding {
  type: 'orphaned-stack' | 'missing-stack';
  stackName?: string;
  pipelineId?: string;
  pipelineName?: string;
  detail: string;
}

const ACTIVE_STATUSES = [
  'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE',
];

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
 * Designed for cron use:
 *   - Exits 0 when there are no findings.
 *   - Exits 1 when at least one orphaned or missing stack is found.
 *   - Exits 2 on AWS errors / scan failures.
 *
 * @example
 * ```bash
 * pipeline-manager audit-stacks --region us-east-1
 * pipeline-manager audit-stacks --org acme --json
 * ```
 */
export function auditStacks(program: Command): void {
  program
    .command('audit-stacks')
    .description('Diff CloudFormation stacks vs pipeline_registry to find orphaned or missing CDK deployments')
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .option('--org <orgId>', 'Filter both registry and stack scan to a single org')
    .option('--json', 'Output results as JSON', false)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = printCommandHeader('Audit Stacks');
      printSslWarning(options.verifySsl);

      const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';

      try {
        // Fetch the platform's view of registered pipelines.
        printInfo('Fetching pipeline registry from platform', { org: options.org ?? '(all)' });
        const client = await createAuthenticatedClientAsync(options);
        const registryRes = await client.get<{ entries: RegistryEntry[] }>(
          `/api/pipelines/registry${options.org ? `?orgId=${encodeURIComponent(options.org)}` : ''}`,
        );
        const entries: RegistryEntry[] = (registryRes as { entries?: RegistryEntry[] })?.entries
          ?? (registryRes as { data?: { entries?: RegistryEntry[] } })?.data?.entries
          ?? [];

        // Fetch stacks from CloudFormation.
        printInfo('Listing CloudFormation stacks', { region });
        const cfn = new CloudFormationClient({ region });
        const stacks: StackInfo[] = [];
        let nextToken: string | undefined;
        let pages = 0;
        do {
          const listResp = await cfn.send(new ListStacksCommand({
            StackStatusFilter: ACTIVE_STATUSES as StackStatus[],
            NextToken: nextToken,
          }));
          for (const summary of listResp.StackSummaries ?? []) {
            if (!summary.StackName) continue;
            // Pull tags via DescribeStacks (ListStacks doesn't include them).
            const desc = await cfn.send(new DescribeStacksCommand({ StackName: summary.StackName }));
            const tags = desc.Stacks?.[0]?.Tags ?? [];
            const pbTag = tags.find((t) => t.Key === 'pipeline-builder')?.Value;
            const orgTag = tags.find((t) => t.Key === 'OrgId' || t.Key === 'orgId')?.Value;
            if (!pbTag) continue; // Not a pipeline-builder stack.
            if (options.org && orgTag && orgTag !== options.org) continue; // Wrong org filter.
            stacks.push({
              stackName: summary.StackName,
              stackStatus: summary.StackStatus ?? 'UNKNOWN',
              region,
              pipelineBuilderTag: pbTag,
              orgIdTag: orgTag,
              creationTime: summary.CreationTime,
            });
          }
          nextToken = listResp.NextToken;
          pages++;
        } while (nextToken && pages < 20);

        // Diff.
        const registryStackNames = new Set(entries.map((e) => e.stackName).filter((n): n is string => !!n));
        const cfnStackNames = new Set(stacks.map((s) => s.stackName));

        const findings: AuditFinding[] = [];
        for (const stack of stacks) {
          if (!registryStackNames.has(stack.stackName)) {
            findings.push({
              type: 'orphaned-stack',
              stackName: stack.stackName,
              detail: `CloudFormation stack tagged pipeline-builder=${stack.pipelineBuilderTag ?? '(unset)'} has no matching pipeline_registry entry`,
            });
          }
        }
        for (const entry of entries) {
          if (entry.stackName && !cfnStackNames.has(entry.stackName)) {
            findings.push({
              type: 'missing-stack',
              stackName: entry.stackName,
              pipelineId: entry.pipelineId,
              pipelineName: entry.pipelineName,
              detail: `Registry entry references stack ${entry.stackName} but no such stack exists in CloudFormation`,
            });
          }
        }

        const exitCode = findings.length > 0 ? 1 : 0;

        if (options.json) {
          console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            region,
            orgFilter: options.org,
            registryEntries: entries.length,
            cfnStacks: stacks.length,
            findings,
            executionId,
          }, null, 2));
        } else {
          printSection('Audit Results');
          printInfo('Counts', {
            registryEntries: String(entries.length),
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
            }
            printError(`${findings.length} drift finding${findings.length === 1 ? '' : 's'}. Review and reconcile manually.`);
          }
        }
        process.exit(exitCode);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: false,
          context: { command: 'audit-stacks', executionId },
        });
        process.exit(2);
      }
    });
}
