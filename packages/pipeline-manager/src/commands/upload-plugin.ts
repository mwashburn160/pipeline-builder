import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import FormData from 'form-data';
import pico from 'picocolors';
import { FILE_SIZE_LIMITS, formatFileSize } from '../config/cli.constants';
import { Plugin, PluginResponse } from '../types';
import { printCommandHeader, printSslWarning, createAuthenticatedClient } from '../utils/command-utils';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler';
import { extractSingleResponse, fileExists, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

const { bold, green } = pico;

/**
 * Registers the `upload-plugin` command with the CLI program.
 *
 * Validates a local plugin ZIP file (size, extension, readability),
 * builds a multipart form, and uploads it to the platform API.
 * Plugin name and version can be auto-detected from the package
 * or overridden via CLI flags.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * cli upload-plugin --file plugin.zip --organization acme
 * cli upload-plugin --file plugin.zip --organization acme --public
 * cli upload-plugin --file plugin.zip --organization acme --name my-plugin --version 1.0.0
 * cli upload-plugin --file plugin.zip --organization acme --no-verify-ssl
 * ```
 */
export function uploadPlugin(program: Command): void {
  program
    .command('upload-plugin')
    .description('Upload and deploy a plugin package')
    .requiredOption('-f, --file <file>', 'Path to plugin ZIP file')
    .requiredOption('-o, --organization <organization>', 'Organization name')
    .option('-n, --name <name>', 'Plugin name (optional, extracted from package if not provided)')
    .option('-v, --version <version>', 'Plugin version (optional, extracted from package if not provided)')
    .option('--public', 'Make plugin publicly accessible', false)
    .option('--active', 'Set plugin as active', true)
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--dry-run', 'Validate file without uploading', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Upload Plugin');

      try {

        // Display parameters
        printInfo('Upload parameters', {
          file: options.file,
          organization: options.organization,
          name: options.name || '(auto-detect)',
          version: options.version || '(auto-detect)',
          public: options.public ? 'Yes' : 'No',
          active: options.active ? 'Yes' : 'No',
          dryRun: options.dryRun,
          verifySsl: options.verifySsl,
        });

        // Security warning for SSL verification disabled
        printSslWarning(options.verifySsl);

        // Validate organization
        if (!options.organization || typeof options.organization !== 'string' || options.organization.trim().length === 0) {
          printError('Invalid organization name', { provided: options.organization });
          throw new ValidationError('Organization must be a non-empty string', 'organization', options.organization);
        }

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
            error: error instanceof Error ? error.message : String(error),
          });
          throw new ValidationError('Plugin file is not readable', 'file', filePath);
        }

        printSuccess('Plugin file validated');

        // Validate version format if provided
        if (options.version) {
          const versionRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
          if (!versionRegex.test(options.version)) {
            printWarning('Version format may be invalid', {
              provided: options.version,
              expected: 'semantic version (e.g., 1.0.0, 1.2.3-beta.1)',
            });
          }
        }

        // Validate name format if provided
        if (options.name) {
          const nameRegex = /^[a-z0-9-]+$/;
          if (!nameRegex.test(options.name)) {
            printWarning('Plugin name format may be invalid', {
              provided: options.name,
              expected: 'lowercase alphanumeric with dashes (e.g., my-plugin-name)',
            });
          }
        }

        // Dry run mode
        if (options.dryRun) {
          console.log('');
          printSection('Dry Run - Validation Complete');
          printSuccess('File validation passed - no upload performed');

          printKeyValue({
            File: filePath,
            Size: sizeFormatted,
            Organization: options.organization,
            Name: options.name || '(will be auto-detected)',
            Version: options.version || '(will be auto-detected)',
            Public: options.public ? 'Yes' : 'No',
            Active: options.active ? 'Yes' : 'No',
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
        formData.append('organization', options.organization);

        if (options.name) formData.append('name', options.name);
        if (options.version) formData.append('version', options.version);
        formData.append('isPublic', options.public ? 'true' : 'false');
        formData.append('isActive', options.active ? 'true' : 'false');

        // Make API request
        const endpoint = config.api.pluginUploadUrl;
        printInfo('Uploading to API', {
          endpoint: `${config.api.baseUrl}${endpoint}`,
        });

        console.log('');
        printWarning('Upload in progress...');
        printInfo('This may take several minutes depending on plugin size and build complexity');
        console.log('');

        const startTime = Date.now();
        const rawResponse = await client.postForm<PluginResponse>(endpoint, formData);
        const duration = Date.now() - startTime;

        const response = extractSingleResponse<Plugin>(rawResponse, 'plugin', 'name');

        if (!response) {
          printError('No valid plugin data in response', {
            responseKeys: rawResponse ? Object.keys(rawResponse) : '(null)',
          });
          throw new Error('Upload failed - no valid plugin data received');
        }

        console.log('');
        printSection('Plugin Uploaded Successfully');

        // Display plugin information
        printKeyValue({
          'Plugin ID': green(bold(response.id)),
          'Name': response.name,
          'Version': response.version,
          'Organization': response.organization,
          'Description': response.description || '(not set)',
        });

        console.log('');
        printKeyValue({
          'File URL': response.fileUrl || '(not available)',
          'File Size': response.fileSize ? `${(response.fileSize / 1024).toFixed(2)} KB` : '(not available)',
          'Checksum': response.checksum ? `${response.checksum.substring(0, 16)}...` : '(not available)',
        });

        console.log('');
        printKeyValue({
          'Public': response.isPublic ? 'Yes' : 'No',
          'Active': response.isActive ? 'Yes' : 'No',
          'Created At': response.createdAt || '(not available)',
          'Uploaded By': response.uploadedBy || '(not available)',
        });

        console.log('');
        printKeyValue({
          'Execution ID': executionId,
          'Upload Duration': `${(duration / 1000).toFixed(2)}s`,
          'Status': green('✓ Success'),
        });

        // Print additional information if available
        if (response.metadata) {
          console.log('');
          printInfo('Plugin metadata available', {
            keys: Object.keys(response.metadata).length,
          });
        }

        // Print deployment logs URL if available
        const resp = response as unknown as Record<string, unknown>;
        const requestId = resp['X-Request-Id'] || resp.requestId;
        if (requestId) {
          console.log('');
          printInfo('Deployment logs available', {
            requestId,
            url: `${config.api.baseUrl}/logs/${requestId}`,
          });
        }

        // Next steps
        console.log('');
        printInfo('Next steps', {
          view: `Use "get-plugin --id ${response.id}" to view plugin details`,
          list: 'Use "list-plugins" to see all plugins',
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'upload-plugin',
            executionId,
            file: options.file,
            organization: options.organization,
            name: options.name,
            version: options.version,
            public: options.public,
            active: options.active,
            verifySsl: options.verifySsl,
          },
        });
      }
    });
}
