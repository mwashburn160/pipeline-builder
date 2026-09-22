// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import readline from 'readline/promises';
import { resolveCatalogMetadata, type PluginCatalogEdits } from '@pipeline-builder/api-core';
import { Command } from 'commander';
import FormData from 'form-data';
import { PUBLISH_REQUIRED_FIELDS, catalogIssues, formatHeuristic, printCatalogReport, validatePluginDir } from './validate-plugin.js';
import { FILE_SIZE_LIMITS, formatFileSize } from '../config/cli.constants.js';
import { type ApiClient } from '../utils/api-client.js';
import { collectCatalogEdits, type Ask } from '../utils/catalog-prompt.js';
import { createAuthenticatedClient, printCommandHeader, printSslWarning, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { buildPluginImage, hasTool, localImageTag, removeImage, spawnExec, type Exec } from '../utils/plugin-docker.js';
import { SOURCE_LABELS, formatCatalogValue } from '../utils/plugin-package.js';
import { scanPreview, type ScanPreview } from '../utils/plugin-scan.js';
import { collectPluginFiles, writeZip } from '../utils/plugin-zip.js';

export interface PublishPluginOptions {
  dir: string;
  yes?: boolean;
  metadata?: string;
  image?: string;
  skipScan?: boolean;
  dryRun?: boolean;
  verifySsl?: boolean;
}

/** A publish refused before anything is uploaded. */
export class PublishPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishPreflightError';
  }
}

/** Unwrap the platform's `{ success, data }` envelope. */
const dataOf = <T>(body: unknown): T => ((body as { data?: T })?.data ?? body) as T;

interface PublisherState {
  publisher: { handle: string } | null;
  isRootOrg: boolean;
  terms: { accepted: boolean };
  publishingEnabled: boolean;
}

/** The server-side prerequisites a publish request needs: checked up front. */
export async function assertCanPublish(client: ApiClient): Promise<string> {
  const state = dataOf<PublisherState>(await client.get(`${client.getConfig().api.pluginUrl}/publisher`));
  if (!state.publishingEnabled) throw new PublishPreflightError('Publishing is turned off on this instance (PLUGIN_PUBLISHING_DISABLED)');
  if (!state.isRootOrg) throw new PublishPreflightError('Teams publish through their root organization: switch to it (PUBLISHER_ROOT_ORG_REQUIRED)');
  if (!state.publisher) throw new PublishPreflightError('Create your publisher profile first: dashboard → Build → Publisher (PUBLISHER_REQUIRED)');
  if (!state.terms.accepted) throw new PublishPreflightError('Accept the current publisher terms on the Publisher page (PUBLISHER_TERMS_REQUIRED)');
  return state.publisher.handle;
}

/**
 * The scan preview: build (or take) the image, SBOM it with syft and scan it
 * with grype. Missing tools are a clear notice, never a silent pass; a
 * critical finding refuses the publish (the platform's gate would).
 */
export function runScanPreview(exec: Exec, opts: { dir: string; dockerfile: string; buildType: string; name: string; version: string; image?: string; buildArgs?: Record<string, string> }): ScanPreview {
  if (!opts.image && opts.buildType !== 'build_image') {
    return { status: 'unavailable', reason: `a ${opts.buildType} plugin has no Dockerfile to build; pass --image to scan the image it runs` };
  }
  if (!hasTool(exec, 'docker')) return { status: 'unavailable', reason: 'docker is not available to build the image' };
  if (!hasTool(exec, 'syft', ['version']) || !hasTool(exec, 'grype', ['version'])) {
    return { status: 'unavailable', reason: 'syft and grype are not both installed (https://github.com/anchore/syft, https://github.com/anchore/grype)' };
  }
  let image = opts.image;
  let built: string | null = null;
  try {
    if (!image) {
      built = localImageTag(opts.name, opts.version);
      const error = buildPluginImage(exec, { dir: opts.dir, dockerfile: opts.dockerfile, tag: built, buildArgs: opts.buildArgs });
      if (error) return { status: 'failed', reason: error };
      image = built;
    }
    return scanPreview(exec, image);
  } finally {
    if (built) removeImage(exec, built);
  }
}

/** Print the resolved metadata with its provenance (the card the directory will render). */
function printResolved(resolved: ReturnType<typeof resolveCatalogMetadata>): void {
  printSection('Catalog metadata to submit');
  for (const [field, value] of Object.entries(resolved.values)) {
    const source = resolved.sources[field as keyof typeof resolved.sources];
    console.log(`  ${field.padEnd(16)} ${formatCatalogValue(value)}${source ? `  [${SOURCE_LABELS[source]}]` : ''}`);
  }
  console.log('');
}

/**
 * The whole publish flow, minus the terminal: pre-flight (server checks, lint,
 * catalog), scan preview, the accept-or-edit step, then one upload with
 * `visibility=public` + `publishRequest=true` (+ the edits as `metadata`).
 * Returns the server's response, or null for a dry run.
 */
export async function runPublish(
  options: PublishPluginOptions,
  deps: { exec?: Exec; ask?: Ask; client?: () => ApiClient } = {},
): Promise<{ edits: PluginCatalogEdits; response: unknown }> {
  const exec = deps.exec ?? spawnExec;

  printSection('Pre-flight', 'server checks + catalog lint + heuristics');
  const report = await validatePluginDir(options.dir, { lint: true });
  const { invalid } = catalogIssues(report.fields);
  const lintErrors = report.lint.filter(l => l.level === 'error');
  for (const w of report.lint.filter(l => l.level === 'warning')) printWarning(w.message);
  for (const h of report.heuristics.filter(x => x.severity === 'medium')) printWarning(formatHeuristic(h));
  const blocking = [
    ...report.problems,
    ...lintErrors.map(l => l.message),
    ...report.heuristics.filter(x => x.severity === 'high').map(formatHeuristic),
  ];
  printCatalogReport(report.fields);
  if (blocking.length) {
    for (const p of blocking) printError(`  • ${p}`);
    throw new PublishPreflightError(`Pre-flight failed with ${blocking.length} problem(s)`);
  }
  printSuccess('Pre-flight passed');

  const spec = report.pkg.spec!;
  printSection('Scan preview', 'syft SBOM + grype');
  if (options.skipScan) {
    printWarning('Scan preview skipped (--skip-scan). The platform scans the image after the build; a critical vulnerability fails the publish gate.');
  } else {
    const scan = runScanPreview(exec, {
      dir: report.pkg.dir,
      dockerfile: path.join(report.pkg.dir, report.pkg.dockerfileName),
      buildType: report.pkg.buildType,
      name: String(spec.name),
      version: String(spec.version),
      image: options.image,
      buildArgs: spec.buildArgs,
    });
    if (scan.status === 'unavailable') {
      printWarning(`Scan preview NOT run: ${scan.reason}. The platform still scans the image after the build, and a critical vulnerability fails the publish gate.`);
    } else if (scan.status === 'failed') {
      throw new PublishPreflightError(`Scan preview failed: ${scan.reason}`);
    } else {
      printKeyValue(Object.fromEntries(Object.entries(scan.counts).map(([k, v]) => [k, String(v)])));
      if (scan.critical.length) {
        for (const c of scan.critical) printError(`  • ${c}`);
        throw new PublishPreflightError(`${scan.critical.length} critical vulnerabilit${scan.critical.length === 1 ? 'y' : 'ies'}: the publish gate would refuse this version`);
      }
      printSuccess('No critical vulnerabilities');
    }
  }

  if (invalid.length) {
    printWarning(`Detected values that are invalid and would be blank: ${invalid.map(f => f.field).join(', ')} — edit them below or fix the package`);
  }
  printSection('Catalog details', 'accept or edit each detected value');
  const edits = await collectCatalogEdits(report.fields, { yes: options.yes, metadataFile: options.metadata, ask: deps.ask });
  const resolved = resolveCatalogMetadata(report.fields, edits);
  printResolved(resolved);
  const missing = [...PUBLISH_REQUIRED_FIELDS].filter(f => resolved.values[f] === null || resolved.values[f] === undefined);
  if (missing.length) throw new PublishPreflightError(`A publish request needs: ${missing.join(', ')} (add them to the package or supply them with --metadata)`);

  const zip = writeZip(collectPluginFiles(report.pkg.dir, { includeImageTar: report.pkg.buildType === 'prebuilt' }));
  if (zip.length > FILE_SIZE_LIMITS.PLUGIN) throw new ValidationError(`Plugin package exceeds ${formatFileSize(FILE_SIZE_LIMITS.PLUGIN)}`);
  printInfo('Package', { size: formatFileSize(zip.length), metadataEdits: Object.keys(edits) });

  if (options.dryRun) {
    printSuccess('Dry run: nothing uploaded');
    return { edits, response: null };
  }
  if (!options.yes && deps.ask) {
    const answer = (await deps.ask(`Upload ${String(spec.name)}@${String(spec.version)} as public and request publishing? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new PublishPreflightError('Cancelled — nothing uploaded');
  }

  const client = (deps.client ?? (() => createAuthenticatedClient(options)))();
  const handle = await assertCanPublish(client);
  const form = new FormData();
  form.append('plugin', zip, { filename: `${String(spec.name)}-${String(spec.version)}.zip`, contentType: 'application/zip' });
  form.append('visibility', 'public');
  form.append('publishRequest', 'true');
  if (Object.keys(edits).length) form.append('metadata', JSON.stringify(edits));
  printSection('Uploading', `as @${handle}`);
  const response = dataOf<Record<string, unknown>>(await client.postForm(client.getConfig().api.pluginUploadUrl, form));
  return { edits, response };
}

/**
 * Register `plugin publish` — pre-flight (the server's schemas, the catalog's
 * Dockerfile rules, publish-required metadata), a local scan preview, the
 * catalog accept-or-edit step, then the upload that submits a publish request
 * once the version is built.
 *
 * Usage:
 *   pipeline-manager plugin publish --dir ./my-linter
 *   pipeline-manager plugin publish --dir ./my-linter --yes
 *   pipeline-manager plugin publish --dir ./my-linter --metadata catalog.yaml
 */
export function publishPlugin(program: Command): void {
  withSslOptions(program
    .command('publish')
    .description('Pre-flight, scan-preview and upload a plugin, then request its listing in the plugin ecosystem')
    .option('--dir <path>', 'Plugin directory', '.')
    .option('-y, --yes', 'Accept every detected catalog value and skip the confirmation', false)
    .option('--metadata <file>', 'Catalog edits (YAML/JSON: summary, description, links, icon, …); no prompt')
    .option('--image <ref>', 'Scan this image instead of building the plugin\'s Dockerfile')
    .option('--skip-scan', 'Skip the local scan preview (the platform still scans)', false)
    .option('--dry-run', 'Run every local step, upload nothing', false))
    .action(async (options: PublishPluginOptions) => {
      const executionId = printCommandHeader('Publish Plugin');
      printSslWarning(options.verifySsl);
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
      try {
        const { response } = await runPublish(options, { ask: rl ? (q: string) => rl.question(q) : undefined });
        if (!response) return;
        const r = response as { pluginName?: string; version?: string; pluginId?: string; publishRequest?: { requestId?: string; status?: string } };
        printSection('Submitted');
        printKeyValue({
          Plugin: `${r.pluginName ?? '?'}@${r.version ?? '?'}`,
          ...(r.publishRequest?.requestId
            ? { 'Publish request': `${r.publishRequest.requestId} (${r.publishRequest.status ?? 'submitted'})` }
            : { 'Publish request': 'submitted automatically when the build completes' }),
        });
        printSuccess('Track the request on the Publisher page → Requests (or GET /api/plugins/publish-requests)', { executionId });
      } catch (err) {
        const code = err instanceof ValidationError || err instanceof PublishPreflightError ? ERROR_CODES.VALIDATION : ERROR_CODES.API_REQUEST;
        handleError(err, code, { debug: program.opts().debug, exit: true, context: { command: 'plugin publish', executionId } });
      } finally {
        rl?.close();
      }
    });
}
