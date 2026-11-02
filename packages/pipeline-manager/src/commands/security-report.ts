// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync } from 'node:fs';
import { SECURITY_REPORT_FORMATS, type SecurityReportFormat } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import {
  createAuthenticatedClientAsync, printCommandHeader, printSslWarning, validateEntityId, withProfileOption, withRegionOption, withSslOptions,
} from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printInfo, printSuccess } from '../utils/output-utils.js';
import { setPipelineId } from '../utils/request-context.js';

/** Refuse a report this large client-side rather than ship it and be refused. */
const MAX_REPORT_BYTES = 10 * 1024 * 1024;

interface UploadOptions {
  pipelineId: string;
  file: string;
  tool: string;
  format: string;
  executionId?: string;
  stage?: string;
  storeTokens?: boolean;
  verifySsl?: boolean;
  region?: string;
  profile?: string;
}

/** The JSON body `POST /api/pipelines/:id/security-reports` takes. */
export interface SecurityReportBody {
  tool: string;
  format: SecurityReportFormat;
  executionId?: string;
  stage?: string;
  report: unknown;
}

/** Read + validate the report and build the upload body. */
export function buildSecurityReportBody(options: Pick<UploadOptions, 'file' | 'tool' | 'format' | 'executionId' | 'stage'>, env: NodeJS.ProcessEnv = process.env): SecurityReportBody {
  if (!(SECURITY_REPORT_FORMATS as readonly string[]).includes(options.format)) {
    throw new ValidationError(`--format must be one of ${SECURITY_REPORT_FORMATS.join(', ')}`, 'format', options.format);
  }
  const tool = options.tool.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(tool)) throw new ValidationError('--tool must be a short tool name (e.g. trivy, grype)', 'tool', options.tool);
  const size = statSync(options.file).size;
  if (size > MAX_REPORT_BYTES) {
    throw new ValidationError(`${options.file} is ${size} bytes — over the ${MAX_REPORT_BYTES}-byte upload limit`, 'file');
  }
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(options.file, 'utf8'));
  } catch {
    throw new ValidationError(`${options.file} is not valid JSON (SARIF, trivy JSON and grype JSON are all JSON)`, 'file');
  }
  // In a CodeBuild step the action env carries the execution id.
  const executionId = options.executionId ?? env.PIPELINE_EXECUTION_ID;
  return {
    tool,
    format: options.format as SecurityReportFormat,
    ...(executionId ? { executionId } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    report,
  };
}

/**
 * Registers `security-report upload`: send one SARIF / trivy-JSON / grype-JSON
 * report to the pipeline's security-report ingest, so findings from scans that
 * run INSIDE a pipeline (application images, dependency trees) land on the
 * platform beside the plugin-image findings instead of only in a build log.
 *
 * Plugin steps upload with curl and their injected scoped key (see
 * pipeline-core `core/security-reports.ts`); this command is for anywhere
 * `pipeline-manager` runs — the synth/bootstrap image, a laptop, other CI.
 *
 * @example
 * ```bash
 * pipeline-manager security-report upload --pipeline-id <id> --file trivy-reports/image.sarif --tool trivy --format sarif
 * ```
 */
export function securityReport(program: Command): void {
  const group = program.command('security-report').description('Upload pipeline security reports (SARIF, trivy/grype JSON)');
  withSslOptions(
    withRegionOption(
      withProfileOption(group
        .command('upload')
        .description('Upload one security report to a pipeline')
        .requiredOption('-p, --pipeline-id <id>', 'Pipeline ID')
        .requiredOption('-f, --file <file>', 'Report file (JSON)')
        .requiredOption('-t, --tool <tool>', 'Tool that produced it (trivy, grype, …)')
        .requiredOption('--format <format>', `Report format (${SECURITY_REPORT_FORMATS.join(', ')})`)
        .option('--execution-id <id>', 'Pipeline execution id (default: PIPELINE_EXECUTION_ID)')
        .option('--stage <name>', 'Stage the report came from')
        .option('--store-tokens', 'Authenticate using the key in AWS Secrets Manager (PLATFORM_SECRET_NAME)', false)),
    ),
  )
    .action(async (options: UploadOptions) => {
      const executionId = printCommandHeader('Upload Security Report');
      try {
        printSslWarning(options.verifySsl);
        const pipelineId = validateEntityId(options.pipelineId, 'Pipeline');
        setPipelineId(pipelineId);
        const body = buildSecurityReportBody(options);
        printInfo('Uploading', { pipelineId, tool: body.tool, format: body.format, file: options.file });
        const client = await createAuthenticatedClientAsync(options);
        await client.post(`${client.getConfig().api.pipelineUrl}/${encodeURIComponent(pipelineId)}/security-reports`, body);
        printSuccess('Security report uploaded', { pipelineId, tool: body.tool });
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'security-report-upload', executionId, pipelineId: options.pipelineId },
        });
      }
    });
}
