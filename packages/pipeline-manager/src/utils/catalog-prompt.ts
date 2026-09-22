// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The §3.1a ACCEPT-OR-EDIT step for `plugin publish`: every descriptive
 * catalog field is shown with its detected value and source, and the author
 * accepts it, edits it or clears it. `--yes` accepts everything detected;
 * `--metadata <file.yaml>` supplies edits non-interactively. Edits pass the
 * same api-core validator the server applies (contract keys refused, G56).
 */

import fs from 'fs';
import path from 'path';
import {
  parseCatalogEdits, validateCatalogField,
  type DetectedField, type PluginCatalogEdits, type PluginCatalogField,
} from '@pipeline-builder/api-core';
import YAML from 'yaml';
import { ValidationError } from './error-handler.js';
import { SOURCE_LABELS, formatCatalogValue } from './plugin-package.js';

/** Fields whose value is long markdown: edited by naming a file. */
const FILE_FIELDS: ReadonlySet<PluginCatalogField> = new Set(['readme', 'changelog']);

/** Asks one question, returns the answer (trimmed by the caller). */
export type Ask = (question: string) => Promise<string>;

/** Read and validate a `--metadata` edits file (YAML or JSON). */
export function readMetadataFile(file: string): PluginCatalogEdits {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new ValidationError(`--metadata file not found: ${abs}`, 'metadata', abs);
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(abs, 'utf-8'), { maxAliasCount: 100 });
  } catch (err) {
    throw new ValidationError(`--metadata: invalid YAML (${(err as Error).message.split('\n')[0]})`, 'metadata', abs);
  }
  const parsed = parseCatalogEdits(raw);
  if (!parsed.ok) throw new ValidationError(`--metadata: ${parsed.error}`, 'metadata', abs);
  return parsed.value;
}

/** Turn a typed answer into a field value (before validation). */
export function parseTypedValue(field: PluginCatalogField, text: string, cwd = process.cwd()): unknown {
  if (FILE_FIELDS.has(field)) {
    const file = path.resolve(cwd, text);
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    return fs.readFileSync(file, 'utf-8');
  }
  if (field === 'keywords') return text.split(',').map(k => k.trim()).filter(Boolean);
  if (field === 'icon') {
    const [key, badge] = text.split(':').map(s => s.trim());
    return badge ? { key, badge } : key;
  }
  return text;
}

/** One line describing a detected field for the prompt. */
export function describeDetected(d: DetectedField): string {
  const source = d.source ? SOURCE_LABELS[d.source] ?? d.source : null;
  if (d.error) return `${d.field}: (blank — detected ${source ?? 'value'} is invalid: ${d.error})`;
  if (d.value === null) return `${d.field}: (empty)`;
  return `${d.field}: ${formatCatalogValue(d.value)}  [${source}]`;
}

/**
 * Walk every field: Enter/`a` accepts, `e` edits (validated, re-asked on a bad
 * value), `c` clears. Returns only the fields the author changed.
 */
export async function promptCatalogEdits(detected: DetectedField[], ask: Ask): Promise<PluginCatalogEdits> {
  const edits: Record<string, unknown> = {};
  for (const d of detected) {
    console.log(`  ${describeDetected(d)}`);
    for (;;) {
      const answer = (await ask('    [A]ccept, [e]dit, [c]lear? ')).trim().toLowerCase();
      if (answer === '' || answer === 'a') break;
      if (answer === 'c') {
        edits[d.field] = null;
        break;
      }
      if (answer !== 'e') continue;
      const hint = FILE_FIELDS.has(d.field) ? 'path to a markdown file' : d.field === 'keywords' ? 'comma-separated' : d.field === 'icon' ? 'key or key:badge' : 'value';
      const typed = (await ask(`    New ${d.field} (${hint}): `)).trim();
      try {
        const checked = validateCatalogField(d.field, parseTypedValue(d.field, typed));
        if (!checked.ok) throw new Error(checked.error);
        edits[d.field] = checked.value;
        break;
      } catch (err) {
        console.log(`    ✗ ${(err as Error).message} — try again`);
      }
    }
  }
  const parsed = parseCatalogEdits(edits);
  if (!parsed.ok) throw new ValidationError(parsed.error);
  return parsed.value;
}

/**
 * Resolve the author's edits, non-interactively when asked: `--metadata` edits
 * (every other detected value accepted) or `--yes` (everything detected
 * accepted); otherwise the interactive prompt. Without a terminal, `--yes` or
 * `--metadata` is required — nothing is accepted silently.
 */
export async function collectCatalogEdits(
  detected: DetectedField[],
  opts: { yes?: boolean; metadataFile?: string; ask?: Ask },
): Promise<PluginCatalogEdits> {
  if (opts.metadataFile) return readMetadataFile(opts.metadataFile);
  if (opts.yes) return {};
  if (!opts.ask) {
    throw new ValidationError('No terminal to prompt on: pass --yes to accept the detected metadata, or --metadata <file.yaml> with your edits');
  }
  return promptCatalogEdits(detected, opts.ask);
}
