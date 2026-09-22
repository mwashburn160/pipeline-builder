// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Command } from 'commander';
import pico from 'picocolors';
import { type OutputFormat } from '../config/cli.constants.js';
import { type Plugin, type PluginYankResponse } from '../types/index.js';
import {
  createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId, withSslOptions,
} from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { outputData, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils.js';
import { extractSingleResponse, unwrapEnvelope } from '../utils/response-utils.js';

const { bold, green, yellow, red } = pico;

/** Server cap on a deprecation message / yank reason. */
export const LIFECYCLE_TEXT_MAX = 500;

interface LifecycleOptions {
  id: string;
  format: OutputFormat;
  output?: string;
  verifySsl?: boolean;
}

/**
 * `POST /api/plugins/:id/<action>`, on the plugins API base (`pluginUrl`): the
 * API gateway routes `/api/plugins/*` to the plugin service.
 */
function lifecycleUrl(client: ReturnType<typeof createAuthenticatedClient>, id: string, action: 'deprecate' | 'yank'): string {
  return `${client.getConfig().api.pluginUrl}/${encodeURIComponent(id)}/${action}`;
}

function checkText(value: string | undefined, flag: string, required: boolean): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (required) throw new ValidationError(`--${flag} is required`, flag);
    return undefined;
  }
  if (trimmed.length > LIFECYCLE_TEXT_MAX) {
    throw new ValidationError(`--${flag} must be at most ${LIFECYCLE_TEXT_MAX} characters`, flag, `${trimmed.length} characters`);
  }
  return trimmed;
}

function finish(executionId: string, startTime: number, plugin: Plugin, options: LifecycleOptions): void {
  printExecutionSummary(executionId, Date.now() - startTime);
  outputData(plugin, { format: options.format, file: options.output, silent: false });
  if (options.output) printSuccess('Plugin data saved', { path: options.output });
}

/**
 * Registers `plugin deprecate`: mark a version deprecated (or clear it with
 * `--undo`). A deprecated version keeps resolving, but synth prints a warning,
 * AI selection stops offering it, and the org approvers of every org whose
 * pipelines use it are notified.
 *
 * @example
 * ```bash
 * pipeline-manager plugin deprecate --id <plugin-id> --message "Use 2.x"
 * pipeline-manager plugin deprecate --id <plugin-id> --undo
 * ```
 */
export function deprecatePlugin(program: Command): void {
  withSslOptions(
    program
      .command('deprecate')
      .description('Deprecate a plugin version (it keeps resolving, with a warning)')
      .requiredOption('-i, --id <id>', 'Plugin ID (one version)')
      .option('-m, --message <text>', `Message shown to users of the version (max ${LIFECYCLE_TEXT_MAX})`)
      .option('--undo', 'Clear the deprecation instead', false)
      .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
      .option('-o, --output <file>', 'Save the updated plugin to file'),
  )
    .action(async (options: LifecycleOptions & { message?: string; undo: boolean }) => {
      const executionId = printCommandHeader(options.undo ? 'Clear Plugin Deprecation' : 'Deprecate Plugin');
      try {
        printSslWarning(options.verifySsl);
        if (options.undo && options.message) {
          throw new ValidationError('--message cannot be combined with --undo', 'message');
        }
        const id = validateEntityId(options.id, 'Plugin');
        const message = checkText(options.message, 'message', false);
        printInfo('Request parameters', { id, deprecated: !options.undo, message: message ?? '(none)' });

        const client = createAuthenticatedClient(options);
        const startTime = Date.now();
        const body = options.undo ? { deprecated: false } : { deprecated: true, ...(message ? { message } : {}) };
        const response = await client.post(lifecycleUrl(client, id, 'deprecate'), body);
        const plugin = extractSingleResponse<Plugin>(response, 'plugin', 'id');
        if (!plugin) throw new Error(`No plugin returned for ID: ${id}`);

        console.log('');
        printSection(options.undo ? 'Deprecation Cleared' : 'Plugin Version Deprecated');
        printKeyValue({
          Plugin: green(bold(`${plugin.name}@${plugin.version}`)),
          Deprecated: plugin.deprecatedAt ? yellow(`yes (${plugin.deprecatedAt})`) : 'no',
          ...(plugin.deprecationMessage ? { Message: plugin.deprecationMessage } : {}),
        });
        finish(executionId, startTime, plugin, options);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin-deprecate', executionId, pluginId: options.id },
        });
      }
    });
}

/**
 * Registers `plugin yank`: stop a version resolving for new synths. Ranges,
 * `latest` and the default skip it; an exact pin still resolves, with a warning
 * carrying the reason. Yanking the default promotes the next version. A version
 * published to the ecosystem is refused (409) — request the yank there.
 *
 * @example
 * ```bash
 * pipeline-manager plugin yank --id <plugin-id> --reason "Leaks tokens in logs; use 1.2.1"
 * ```
 */
export function yankPlugin(program: Command): void {
  withSslOptions(
    program
      .command('yank')
      .description('Yank a plugin version (stops resolving for ranges, latest and the default)')
      .requiredOption('-i, --id <id>', 'Plugin ID (one version)')
      .requiredOption('-r, --reason <text>', `Why it was yanked, shown to exact pins (max ${LIFECYCLE_TEXT_MAX})`)
      .option('-f, --format <format>', 'Output format (json, yaml, table)', 'json')
      .option('-o, --output <file>', 'Save the updated plugin to file'),
  )
    .action(async (options: LifecycleOptions & { reason: string }) => {
      const executionId = printCommandHeader('Yank Plugin');
      try {
        printSslWarning(options.verifySsl);
        const id = validateEntityId(options.id, 'Plugin');
        const reason = checkText(options.reason, 'reason', true)!;
        printInfo('Request parameters', { id, reason });

        const client = createAuthenticatedClient(options);
        const startTime = Date.now();
        const response = await client.post(lifecycleUrl(client, id, 'yank'), { reason });
        const plugin = extractSingleResponse<Plugin>(response, 'plugin', 'id');
        if (!plugin) throw new Error(`No plugin returned for ID: ${id}`);
        const promoted = (unwrapEnvelope(response) as Partial<PluginYankResponse>).promotedDefault;

        console.log('');
        printSection('Plugin Version Yanked');
        printKeyValue({
          Plugin: green(bold(`${plugin.name}@${plugin.version}`)),
          Yanked: red(plugin.yankedAt ?? 'yes'),
          Reason: plugin.yankReason ?? reason,
          ...(promoted ? { 'New default': `${plugin.name}@${promoted.version}` } : {}),
        });
        finish(executionId, startTime, plugin, options);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin-yank', executionId, pluginId: options.id },
        });
      }
    });
}
