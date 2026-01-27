import * as fs from 'fs';
import { Command } from 'commander';
import FormData from 'form-data';
import { ApiClient } from '../utils/api-client';
import { getConfig } from '../utils/config-loader';
import { assert, ERROR_CODES, handleError, ValidationError } from '../utils/error-handler';
import { fileExists, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils';

/**
 * Upload plugin command
 *
 * Usage:
 *   cli upload-plugin --file plugin.zip
 *   cli upload-plugin --file plugin.zip --public
 */
export function upload_plugin(program: Command): void {
  program
    .command('upload-plugin')
    .description('Upload and deploy a plugin package')
    .requiredOption('-f, --file <file>', 'Path to plugin ZIP file')
    .option('--public', 'Make plugin publicly accessible (default: private)', false)
    .action(async (options) => {
      try {
        printSection('Upload Plugin');

        printInfo('Configuration', {
          file: options.file,
          accessModifier: options.public ? 'public' : 'private',
        });

        // Load configuration
        const config = getConfig();

        // Validate file exists
        assert(fileExists(options.file), `Plugin file not found: ${options.file}`, 'file');

        // Validate file is a ZIP
        if (!options.file.toLowerCase().endsWith('.zip')) {
          throw new ValidationError('Plugin file must be a ZIP archive', 'file', options.file);
        }

        // Get file stats
        const stats = fs.statSync(options.file);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        printInfo('Plugin file validated', {
          path: options.file,
          size: `${sizeMB} MB`,
        });

        // Check file size (100MB limit)
        const maxSize = 100 * 1024 * 1024;
        if (stats.size > maxSize) {
          throw new ValidationError(
            `Plugin file exceeds maximum size of 100MB (actual: ${sizeMB} MB)`,
            'file.size',
            stats.size,
          );
        }

        printSuccess('Plugin file validated');

        // Create form data
        const formData = new FormData();
        formData.append('plugin', fs.createReadStream(options.file));
        formData.append('accessModifier', options.public ? 'public' : 'private');

        // Make API request
        printInfo('Uploading to API', {
          endpoint: `${config.api.baseUrl}${config.api.pluginUploadUrl}`,
        });
        printWarning('This may take several minutes depending on plugin size and build complexity...');

        const client = new ApiClient(config);
        const response = await client.postForm(
          config.api.pluginUploadUrl,
          formData,
        );

        printSection('Plugin Deployed');
        printKeyValue({
          'ID': response.id,
          'Name': response.name,
          'Version': response.version,
          'Image Tag': response.imageTag,
          'Full Image': response.fullImage,
          'Access Modifier': response.accessModifier,
          'Is Default': response.isDefault,
          'Is Active': response.isActive,
        });

        // Print SSE logs URL if available
        if (response['X-Request-Id']) {
          printInfo('View deployment logs', {
            url: `${config.api.baseUrl}/logs/${response['X-Request-Id']}`,
          });
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'upload-plugin',
            file: options.file,
            accessModifier: options.public ? 'public' : 'private',
          },
        });
      }
    });
}