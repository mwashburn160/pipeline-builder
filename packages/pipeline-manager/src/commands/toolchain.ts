// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withSslOptions } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSuccess } from '../utils/output-utils.js';
import { exportToolchain } from '../utils/toolchain.js';

/**
 * `pipeline-manager toolchain …` — the pipeline toolchain release
 * (pipeline-bootstrap + cdk-synth, one version).
 *
 * `toolchain export [--release <V>] [--output <file>]` resolves both halves the
 * way a synth does — `--release` as the pin, else whatever your org resolves
 * to now (its default, a canary, or the platform default) — and writes the
 * JSON `pipeline deploy --local-spec --toolchain-file` deploys from: both
 * images' repositories and signed digests, the release version and its tool
 * versions. Read-only; nothing on the platform changes.
 *
 * @example
 * ```bash
 * pipeline-manager toolchain export --output toolchain.json
 * pipeline-manager toolchain export --release 1.4.0 --output toolchain-1.4.0.json
 * pipeline-manager pipeline deploy --local-spec pipeline.json --toolchain-file toolchain.json
 * ```
 */
export function toolchain(program: Command): void {
  const group = program.command('toolchain').description('Inspect and export the pipeline toolchain release (pipeline-bootstrap + cdk-synth)');

  withSslOptions(group
    .command('export')
    .description('Write the resolved toolchain release (both images\' digests, repositories and tool versions) as JSON, for `pipeline deploy --local-spec --toolchain-file`')
    .option('--release <version>', 'Export this release (default: the release your organization resolves to now)')
    .option('-o, --output <file>', 'Output file (default: stdout)'))
    .action(async (options) => {
      // With no --output the JSON goes to stdout, so the header goes nowhere near it.
      const toStdout = !options.output;
      const executionId = printCommandHeader('Toolchain Export', undefined, { quiet: toStdout });
      try {
        printSslWarning(options.verifySsl);
        const client = await createAuthenticatedClientAsync(options);
        const file = await exportToolchain(client, options.release);
        const json = `${JSON.stringify(file, null, 2)}\n`;
        if (toStdout) {
          process.stdout.write(json);
          return;
        }
        const out = path.resolve(options.output);
        fs.writeFileSync(out, json, { mode: 0o644 });
        printSuccess('Toolchain release exported');
        printKeyValue({
          'Release': file.releaseVersion,
          'Resolved via': file.resolvedVia,
          'pipeline-bootstrap': `${file.bootstrap.imageRepository}@${file.bootstrap.imageDigest}`,
          'cdk-synth': `${file.synth.imageRepository}@${file.synth.imageDigest}`,
          'File': out,
        });
        printInfo('Deploy with', { command: `pipeline-manager pipeline deploy --local-spec <pipeline.json> --toolchain-file ${options.output}` });
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'toolchain export', executionId, release: options.release },
        });
      }
    });
}
