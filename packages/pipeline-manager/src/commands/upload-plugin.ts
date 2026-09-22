// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '@pipeline-builder/api-core';
import { Command } from 'commander';
import FormData from 'form-data';
import ora from 'ora';
import pico from 'picocolors';
import { FILE_SIZE_LIMITS, formatFileSize } from '../config/cli.constants.js';
import { printCommandHeader, printSslWarning, createAuthenticatedClient, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { fileExists, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { unwrapEnvelope } from '../utils/response-utils.js';

/** The upload route's success payload (`POST /plugins/upload`). */
interface PluginUploadResult {
  requestId?: string;
  pluginName?: string;
  version?: string;
  /** Present only on 201 (metadata-only plugin, deployed without a build). */
  pluginId?: string;
  buildType?: string;
}

const { bold, green } = pico;

/**
 * Registers the `upload-plugin` command with the CLI program.
 *
 * Validates a local plugin ZIP file (size, extension, readability),
 * builds a multipart form, and uploads it to the platform API. The
 * plugin's name and version always come from the package's
 * `plugin-spec.yaml`, and the organization from the signed-in session.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * cli plugin upload --file plugin.zip
 * cli plugin upload --file plugin.zip --public
 * cli plugin upload --file plugin.zip --no-verify-ssl
 * ```
 */
export function uploadPlugin(program: Command): void {
  withSslOptions(program
    .command('upload')
    .description('Upload and deploy a plugin package')
    .requiredOption('-f, --file <file>', 'Path to plugin ZIP file')
    .option('--public', 'Make plugin publicly accessible (needs plugins:publish)', false))
    .option('--dry-run', 'Validate file without uploading', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Upload Plugin');

      try {

        // Display parameters
        printInfo('Upload parameters', {
          file: options.file,
          public: options.public ? 'Yes' : 'No',
          dryRun: options.dryRun,
          verifySsl: options.verifySsl,
        });

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        // Validate file path
        if (!options.file || typeof options.file !== 'string' || options.file.trim().length === 0) {
          printError('Invalid file path', { provided: options.file });
          throw new ValidationError('File path must be a non-empty string', 'file', options.file);
        }

        const filePath = path.resolve(options.file);

        // Validate file exists
        printInfo('Validating plugin file', { path: filePath });

        if (!fileExists(filePath)) {
          printError('Plugin file not found', { path: filePath });
          throw new ValidationError(`Plugin file not found: ${filePath}`, 'file', filePath);
        }

        // Validate file extension
        const fileExt = path.extname(filePath).toLowerCase();
        if (fileExt !== '.zip') {
          printWarning('File extension is not .zip', {
            provided: fileExt,
            expected: '.zip',
          });
          throw new ValidationError('Plugin file must be a ZIP archive', 'file', filePath);
        }

        // Get file stats
        const stats = fs.statSync(filePath);
        const sizeBytes = stats.size;
        const sizeFormatted = formatFileSize(sizeBytes);

        printSuccess('Plugin file found', {
          path: filePath,
          size: sizeFormatted,
          modified: new Date(stats.mtime).toLocaleString(),
        });

        // Check file size
        if (sizeBytes > FILE_SIZE_LIMITS.PLUGIN) {
          printError('Plugin file too large', {
            size: sizeFormatted,
            maximum: formatFileSize(FILE_SIZE_LIMITS.PLUGIN),
            exceededBy: formatFileSize(sizeBytes - FILE_SIZE_LIMITS.PLUGIN),
          });
          throw new ValidationError(
            `Plugin file exceeds maximum size of ${formatFileSize(FILE_SIZE_LIMITS.PLUGIN)} (actual: ${sizeFormatted})`,
            'file.size',
            sizeBytes,
          );
        }

        // Check if file is readable
        try {
          fs.accessSync(filePath, fs.constants.R_OK);
        } catch (error) {
          printError('Cannot read plugin file', {
            path: filePath,
            error: errorMessage(error),
          });
          throw new ValidationError('Plugin file is not readable', 'file', filePath);
        }

        printSuccess('Plugin file validated');

        // Dry run mode
        if (options.dryRun) {
          console.log('');
          printSection('Dry Run - Validation Complete');
          printSuccess('File validation passed - no upload performed');

          printKeyValue({
            File: filePath,
            Size: sizeFormatted,
            Public: options.public ? 'Yes' : 'No',
          });

          return;
        }

        // Create authenticated API client
        const client = createAuthenticatedClient(options);
        const config = client.getConfig();

        // Create form data
        console.log('');
        printSection('Uploading Plugin');
        printInfo('Preparing upload', {
          file: path.basename(filePath),
          size: sizeFormatted,
        });

        const formData = new FormData();
        formData.append('plugin', fs.createReadStream(filePath), {
          filename: path.basename(filePath),
          contentType: 'application/zip',
        });
        // The upload API reads `visibility` (private | org | public); without
        // it the version is `org`. `public` needs plugins:publish. Name and
        // version come from the package's spec; the org from the session.
        if (options.public) formData.append('visibility', 'public');

        // Make API request
        const endpoint = config.api.pluginUploadUrl;
        printInfo('Uploading to API', {
          endpoint: `${config.api.baseUrl}${endpoint}`,
        });

        console.log('');

        const spinner = ora('Uploading plugin...').start();
        let rawResponse: unknown;
        let duration: number;
        try {
          const startTime = Date.now();
          rawResponse = await client.postForm<unknown>(endpoint, formData);
          duration = Date.now() - startTime;
          spinner.succeed('Plugin uploaded');
        } catch (error) {
          spinner.fail('Upload failed');
          throw error;
        }

        const response = unwrapEnvelope(rawResponse) as PluginUploadResult;
        if (!response.pluginName) {
          printError('No valid upload result in response', {
            responseKeys: Object.keys(response).join(', ') || '(none)',
          });
          throw new Error('Upload failed - no valid upload result received');
        }

        // 201: a metadata-only plugin, deployed directly (has a pluginId).
        // 202: the image build was queued; the worker persists the version.
        const queued = !response.pluginId;
        console.log('');
        printSection(queued ? 'Plugin Build Queued' : 'Plugin Deployed');
        printKeyValue({
          'Plugin': green(bold(`${response.pluginName}@${response.version ?? '?'}`)),
          ...(response.pluginId ? { 'Plugin ID': response.pluginId } : {}),
          'Request ID': response.requestId ?? '(not available)',
          'Visibility': options.public ? 'public' : 'org',
        });

        console.log('');
        printKeyValue({
          'Execution ID': executionId,
          'Upload Duration': `${(duration / 1000).toFixed(2)}s`,
          'Status': green('✓ Success'),
        });

        // Next steps
        console.log('');
        printInfo('Next steps', {
          ...(response.pluginId
            ? { view: `Use "plugin get --id ${response.pluginId}" to view plugin details` }
            : { build: 'The version appears in "plugin list" once its image build completes' }),
          list: 'Use "plugin list" to see all plugins',
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'upload-plugin',
            executionId,
            file: options.file,
            public: options.public,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
