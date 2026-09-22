// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import {
  HEURISTICS_MAX_FILE_BYTES, lintPluginDockerfile, lintPluginSpec, scanPluginSourceHeuristics,
  type DetectedField, type HeuristicFinding, type HeuristicsInputFile, type PluginCatalogField, type PluginLintFinding,
} from '@pipeline-builder/api-core';
import { Command } from 'commander';
import pico from 'picocolors';
import { printCommandHeader } from '../utils/command-utils.js';
import { ERROR_CODES, handleError, ValidationError } from '../utils/error-handler.js';
import { printError, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import {
  SOURCE_LABELS, detectPackageCatalog, formatCatalogValue, packageProblems, readPluginPackage, type PluginPackage,
} from '../utils/plugin-package.js';

const { dim, green, red, yellow } = pico;

/** Fields a version needs before a publish request is accepted (the publish gates). */
export const PUBLISH_REQUIRED_FIELDS: ReadonlySet<PluginCatalogField> = new Set(['license', 'readme']);

export interface ValidationReport {
  pkg: PluginPackage;
  /** What the upload would refuse. */
  problems: string[];
  /** test-plugins.sh-equivalent findings (only when linted). */
  lint: PluginLintFinding[];
  /** The catalog fields as the server will detect them. */
  fields: DetectedField[];
  /** The malware heuristics the anonymous-submission gate runs: `high` fails, `medium` warns. */
  heuristics: HeuristicFinding[];
}

/** Every regular file under the plugin dir (what the zip would carry), bounded like the server's read. */
export function readPackageFilesForHeuristics(dir: string, max = 2_000): HeuristicsInputFile[] {
  const out: HeuristicsInputFile[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {walk(full);} else if (entry.isFile()) {
        const fd = fs.openSync(full, 'r');
        try {
          const buf = Buffer.alloc(HEURISTICS_MAX_FILE_BYTES + 1);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          out.push({ path: path.relative(dir, full).split(path.sep).join('/'), content: buf.subarray(0, n) });
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** A heuristic finding as one line of CLI output. */
export function formatHeuristic(f: HeuristicFinding): string {
  return `heuristics: ${f.message} (${f.path}:${f.line}) — ${f.excerpt}`;
}

/** Validate a plugin directory: server checks, optional catalog lint, catalog detection. */
export async function validatePluginDir(dir: string, opts: { lint: boolean }): Promise<ValidationReport> {
  const pkg = readPluginPackage(dir);
  const problems = await packageProblems(pkg);
  const lint: PluginLintFinding[] = [];
  if (opts.lint) {
    const specText = fs.readFileSync(path.join(pkg.dir, pkg.specFile), 'utf-8');
    lint.push(...lintPluginSpec(pkg.rawSpec, specText));
    if (pkg.dockerfileContent !== null) lint.push(...lintPluginDockerfile(pkg.dockerfileContent));
  }
  const heuristics = scanPluginSourceHeuristics(readPackageFilesForHeuristics(pkg.dir)).findings;
  return { pkg, problems, lint, fields: detectPackageCatalog(pkg), heuristics };
}

/** Invalid detected values (blanked by the server) and publish-required fields left empty. */
export function catalogIssues(fields: DetectedField[]): { invalid: DetectedField[]; missingForPublish: DetectedField[] } {
  return {
    invalid: fields.filter(f => f.error),
    missingForPublish: fields.filter(f => !f.error && f.value === null && PUBLISH_REQUIRED_FIELDS.has(f.field)),
  };
}

/** Print each catalog field with its value (or why it's blank) and where it came from. */
export function printCatalogReport(fields: DetectedField[]): void {
  printSection('Catalog metadata', 'as the server will detect it (spec → README → Dockerfile label → generated)');
  const width = Math.max(...fields.map(f => f.field.length));
  for (const f of fields) {
    const label = f.field.padEnd(width);
    const source = f.source ? dim(`[${SOURCE_LABELS[f.source] ?? f.source}]`) : '';
    if (f.error) {
      console.log(`  ${red('✗')} ${label}  ${red(`invalid — ${f.error}`)} ${source}`);
    } else if (f.value === null) {
      const required = PUBLISH_REQUIRED_FIELDS.has(f.field);
      console.log(`  ${required ? yellow('!') : dim('·')} ${label}  ${dim('(empty)')}${required ? yellow('  required to publish') : ''}`);
    } else {
      console.log(`  ${green('✓')} ${label}  ${formatCatalogValue(f.value)} ${source}`);
    }
  }
  console.log('');
}

interface ValidatePluginOptions {
  dir: string;
  lint?: boolean;
  json?: boolean;
}

/**
 * Register `plugin validate` — the upload's own checks against a LOCAL plugin
 * directory (the server's Zod spec/config schemas and template contract, shared
 * from api-core), plus a report of every catalog field: its detected value, its
 * source, and whether it would be empty or invalid. `--lint` adds the
 * catalog's Dockerfile rules (test-plugins.sh). Exits non-zero on any problem,
 * any invalid detected catalog value or any lint error (CI-friendly).
 *
 * Usage:
 *   pipeline-manager plugin validate --dir ./my-linter
 *   pipeline-manager plugin validate --dir ./my-linter --lint --json
 */
export function validatePlugin(program: Command): void {
  program
    .command('validate')
    .description('Validate a local plugin with the server\'s schemas and report its catalog metadata')
    .option('--dir <path>', 'Path to the plugin directory', '.')
    .option('--lint', 'Also apply the catalog\'s Dockerfile and spec rules (test-plugins.sh)', false)
    .option('--json', 'Print the report as JSON', false)
    .action(async (options: ValidatePluginOptions) => {
      const executionId = printCommandHeader('Validate Plugin', undefined, { quiet: options.json });
      try {
        const report = await validatePluginDir(options.dir, { lint: !!options.lint });
        const { invalid, missingForPublish } = catalogIssues(report.fields);
        const lintErrors = report.lint.filter(l => l.level === 'error');
        const highHeuristics = report.heuristics.filter(h => h.severity === 'high');
        const failed = report.problems.length > 0 || invalid.length > 0 || lintErrors.length > 0 || highHeuristics.length > 0;

        if (options.json) {
          console.log(JSON.stringify({
            valid: !failed,
            problems: report.problems,
            lint: report.lint,
            heuristics: report.heuristics,
            catalog: report.fields,
            missingForPublish: missingForPublish.map(f => f.field),
          }, null, 2));
          if (failed) process.exit(1);
          return;
        }

        printCatalogReport(report.fields);
        for (const w of report.lint.filter(l => l.level === 'warning')) printWarning(w.message);
        for (const h of report.heuristics.filter(x => x.severity === 'medium')) printWarning(formatHeuristic(h));
        if (missingForPublish.length) printWarning(`Needed before a publish request: ${missingForPublish.map(f => f.field).join(', ')}`);
        if (!failed) {
          printSuccess(`Plugin '${String(report.pkg.rawSpec.name)}' is valid`, { executionId, buildType: report.pkg.buildType });
          return;
        }
        const all = [
          ...report.problems,
          ...invalid.map(f => `catalog: ${f.field} would be blank — ${f.error}`),
          ...lintErrors.map(l => l.message),
          ...highHeuristics.map(formatHeuristic),
        ];
        printWarning(`Found ${all.length} problem(s):`);
        for (const p of all) printError(`  • ${p}`);
        process.exit(1);
      } catch (err) {
        handleError(err, err instanceof ValidationError ? ERROR_CODES.VALIDATION : ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'plugin validate', executionId },
        });
      }
    });
}
