// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  SQSClient,
  GetQueueAttributesCommand,
  ListMessageMoveTasksCommand,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { Command } from 'commander';
import { applyAwsProfile, resolveAwsRegion } from '../utils/aws-env.js';
import { printCommandHeader, withProfileOption, withRegionOption } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';

// CFN stack that setup-events deploys — the queues live here.
const STACK_NAME = 'pipeline-builder-events';

/**
 * Registers the `redrive-events` command with the CLI program.
 *
 * Manual fallback for the events Lambda's self-healing redrive (Phase 3): calls
 * SQS `StartMessageMoveTask(DLQ → main queue)` for the `pipeline-builder-events`
 * stack, moving messages that exhausted their receive count in the dead-letter
 * queue back onto `pipeline-builder-events` so the ingestion Lambda re-processes
 * them. Idempotent ingest (dedupe on `idempotencyKey`) prevents double-counting.
 *
 * The Lambda already does this automatically after a successful batch; this
 * command is the operator escape hatch when the Lambda is down or the DLQ needs
 * to be drained on demand. Like the Lambda, it refuses to start a second move
 * task while one is already active (SQS allows only one in-flight task per
 * source queue anyway).
 *
 * @example
 * ```bash
 * pipeline-manager infra redrive-events --region us-east-1
 * pipeline-manager infra redrive-events --region us-east-1 --profile prod
 * ```
 */
export function redriveEvents(program: Command): void {
  withProfileOption(
    withRegionOption(program
      .command('redrive-events')
      .description('Redrive dead-lettered CodePipeline events back onto the ingestion queue (manual fallback for the Lambda self-healing redrive)')),
  )
    .action(async (options) => {
      const executionId = printCommandHeader('Redrive Events');

      try {
        const region = resolveAwsRegion(options.region);
        // Honor --profile for the SDK clients below (mirrors setup-events) — without
        // this the SDK hits the DEFAULT account while any accompanying CLI call
        // honored --profile (silent split-brain).
        applyAwsProfile(options.profile);

        printInfo('Parameters', { stack: STACK_NAME, region });

        // Step 1: resolve the queue URLs from the stack outputs (source of truth —
        // no hardcoded queue names). setup-events must have run first.
        printSection('Resolve Queues');

        const cfnClient = new CloudFormationClient({ region });
        const describeResult = await cfnClient.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
        const outputs = describeResult.Stacks?.[0]?.Outputs ?? [];
        const outputMap = Object.fromEntries(outputs.map(o => [o.OutputKey ?? '', o.OutputValue ?? '']));

        const eventQueueArn = outputMap.EventQueueArn;
        const eventQueueUrl = outputMap.EventQueueUrl;
        const dlqUrl = outputMap.DeadLetterQueueUrl;

        if (!eventQueueArn || !dlqUrl) {
          printError(`Stack ${STACK_NAME} is missing expected outputs`, {
            hint: 'Run `pipeline-manager infra setup-events` first.',
          });
          throw new Error('Stack outputs EventQueueArn / DeadLetterQueueUrl not found');
        }

        const sqs = new SQSClient({ region });

        // The stack exposes the DLQ URL but not its ARN — StartMessageMoveTask needs
        // the source ARN, so resolve it from the queue's attributes.
        const dlqAttrs = await sqs.send(new GetQueueAttributesCommand({
          QueueUrl: dlqUrl,
          AttributeNames: ['QueueArn', 'ApproximateNumberOfMessages'],
        }));
        const dlqArn = dlqAttrs.Attributes?.QueueArn;
        const dlqDepth = Number(dlqAttrs.Attributes?.ApproximateNumberOfMessages ?? '0');

        if (!dlqArn) {
          throw new Error(`Could not resolve the DLQ ARN from ${dlqUrl}`);
        }

        printKeyValue({
          'Source (DLQ)': dlqArn,
          'Destination (queue)': eventQueueArn,
          'DLQ depth (approx)': String(dlqDepth),
        });

        // Nothing to move — bail early so the operator gets a clear signal instead
        // of a no-op task.
        if (dlqDepth === 0) {
          printSuccess('Dead-letter queue is empty — nothing to redrive.');
          return;
        }

        // Step 2: refuse to stack move tasks. SQS permits only one in-flight move
        // task per source queue; surface any active one instead of erroring out.
        printSection('Redrive');

        const active = await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn }));
        const running = (active.Results ?? []).find(t => t.Status === 'RUNNING');
        if (running) {
          printWarning('A message move task is already running for this DLQ — not starting another.', {
            taskHandle: running.TaskHandle,
            approxMovedSoFar: running.ApproximateNumberOfMessagesMoved,
          });
          return;
        }

        // Step 3: start the move (DLQ → main queue). DestinationArn is set explicitly
        // even though SQS would default to the original source queue — the main
        // ingestion queue is exactly that target.
        const start = await sqs.send(new StartMessageMoveTaskCommand({
          SourceArn: dlqArn,
          DestinationArn: eventQueueArn,
        }));

        console.log('');
        printSection('Redrive Started');
        printKeyValue({
          'Task Handle': start.TaskHandle ?? '(none returned)',
          'Source (DLQ)': dlqArn,
          'Destination (queue)': eventQueueUrl || eventQueueArn,
          'Messages queued': String(dlqDepth),
          'Status': '✓ Started',
        });

        console.log('');
        printSuccess('Redrive task started. Messages will re-flow through the ingestion Lambda.');
        printInfo('Idempotent ingest dedupes on idempotencyKey, so re-driven events are not double-counted.');

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'redrive-events', executionId, stack: STACK_NAME },
        });
      }
    });
}
