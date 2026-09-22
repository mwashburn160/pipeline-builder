// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog metadata: DETECTED from the package, then ACCEPTED OR EDITED
 * (docs/plugin-publishing.md).
 *
 * Sources, highest priority first — the first non-empty value wins, per field:
 *
 * | Field              | 1. spec            | 2. README.md       | 3. own Dockerfile LABEL                 |
 * |--------------------|--------------------|--------------------|-----------------------------------------|
 * | summary            | `summary`          | —                  | — (then first sentence of description)  |
 * | description        | `description`      | first paragraph    | `org.opencontainers.image.description`  |
 * | displayName        | —                  | first `# heading`  | `org.opencontainers.image.title`        |
 * | license            | `license`          | —                  | `org.opencontainers.image.licenses`     |
 * | homepageUrl        | `homepageUrl`      | —                  | `org.opencontainers.image.url`          |
 * | sourceUrl          | `sourceUrl`        | —                  | `org.opencontainers.image.source`       |
 * | documentationUrl   | `documentationUrl` | —                  | `org.opencontainers.image.documentation`|
 * | category, keywords, icon, changelog | spec | —              | —                                       |
 * | readme             | —                  | `README.md`        | —                                       |
 *
 * Every value — detected or typed — passes the ONE shared validator
 * (api-core `validateCatalogField`). A detected value that fails is returned
 * BLANK WITH THE REASON, never silently dropped, and is not stored unless the
 * user supplies a valid replacement.
 *
 * Pure and shared from api-core: the plugin service's upload and inspect
 * routes and the CLI's `plugin validate` / `plugin publish` run this one
 * detection, so the CLI reports exactly what the server will detect.
 */

import { OCI_LABELS, parseDockerfile } from './dockerfile-static.js';
import {
  PLUGIN_CATALOG_FIELDS, PLUGIN_SUMMARY_MAX,
  type MetadataSource, type MetadataSources, type PluginCatalogField,
} from '../types/plugin-catalog.js';
import {
  PluginCatalogEditsSchema, contractKeysMessage, findContractKeys, validateCatalogField, type PluginCatalogEdits,
} from './plugin-catalog-metadata.js';

/** A source a value can be DETECTED from (`user` is only ever an edit). */
export type DetectedSource = Exclude<MetadataSource, 'user'>;

/** One descriptive field as detected from the package. */
export interface DetectedField {
  field: PluginCatalogField;
  /** The validated (normalized) value, or null when none was found or it failed validation. */
  value: unknown;
  /** Where the winning candidate came from, or null when no source had one. */
  source: DetectedSource | null;
  /** Why the winning candidate was refused, or null. */
  error: string | null;
}

/** The spec fields detection reads (a structural subset of the plugin spec). */
export interface CatalogSpecFields {
  readonly description?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly keywords?: readonly string[];
  readonly license?: string;
  readonly homepageUrl?: string;
  readonly sourceUrl?: string;
  readonly documentationUrl?: string;
  readonly icon?: string | { key: string; badge?: string };
  readonly changelog?: string;
}

/** What detection reads: the spec, the zip-root README and the plugin's own Dockerfile. */
export interface CatalogInputs {
  spec: CatalogSpecFields;
  readmeMd: string | null;
  dockerfileContent: string | null;
}

/** The accepted/edited values of every descriptive field, plus their provenance. */
export interface ResolvedCatalog {
  values: Record<PluginCatalogField, unknown>;
  sources: MetadataSources;
}
// -----------------------------------------------------------------------------
// README reading
// -----------------------------------------------------------------------------

/** Strip inline markdown down to readable text (links → text, images/emphasis/code marks removed). */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images / badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/<[^>]+>/g, '') // inline HTML
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown lines outside fenced code blocks, in order. */
function proseLines(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push('');
      continue;
    }
    out.push(fenced ? '' : line);
  }
  return out;
}

/** The README's first level-1 ATX heading (`# Title`), as plain text. */
export function readmeTitle(md: string): string | null {
  for (const line of proseLines(md)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const title = stripInlineMarkdown(m[1]!);
      return title || null;
    }
  }
  return null;
}

/**
 * The README's first prose paragraph: the first block of consecutive text
 * lines that is not a heading, badge row, list, table, quote, rule or HTML.
 */
export function readmeFirstParagraph(md: string): string | null {
  const isStructural = (l: string): boolean =>
    /^\s*(#|>|[-*+]\s|\d+[.)]\s|\||<|---|\*\*\*|===)/.test(l);
  let para: string[] = [];
  for (const line of [...proseLines(md), '']) {
    if (line.trim() === '' || isStructural(line)) {
      if (para.length > 0) {
        const text = stripInlineMarkdown(para.join(' '));
        if (text) return text;
      }
      para = [];
      continue;
    }
    para.push(line.trim());
  }
  return null;
}

/**
 * The first sentence of `text`, capped at {@link PLUGIN_SUMMARY_MAX}: cut at
 * the first `.`/`!`/`?` followed by whitespace (or the end), else the first
 * line; an over-long sentence is shortened on a word boundary with `…`.
 */
export function firstSentence(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const sentence = (m ? m[1]! : flat).trim();
  if (sentence.length <= PLUGIN_SUMMARY_MAX) return sentence;
  const cut = sentence.slice(0, PLUGIN_SUMMARY_MAX - 1);
  const atWord = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return `${atWord.replace(/[\s,;:]+$/, '')}…`;
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

type Candidate = [DetectedSource, unknown];

const nonEmpty = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);

/** Pick the first non-empty candidate and validate it (blank + reason on failure). */
function pick(field: PluginCatalogField, candidates: Candidate[]): DetectedField {
  const winner = candidates.find(([, v]) => nonEmpty(v));
  if (!winner) return { field, value: null, source: null, error: null };
  const [source, raw] = winner;
  const checked = validateCatalogField(field, raw);
  return checked.ok
    ? { field, value: checked.value, source, error: null }
    : { field, value: null, source, error: checked.error };
}

/** The summary derived from a description, as a detected field. */
function derivedSummary(description: unknown): DetectedField {
  const sentence = typeof description === 'string' ? firstSentence(description) : null;
  return pick('summary', [['derived', sentence]]);
}

/**
 * Detect every descriptive field from the package, in
 * `PLUGIN_CATALOG_FIELDS` order. Pure; never throws.
 */
export function detectCatalogMetadata(inputs: CatalogInputs): DetectedField[] {
  const { spec } = inputs;
  const readme = inputs.readmeMd;
  const labels = parseDockerfile(inputs.dockerfileContent).labels;
  const label = (key: string): string | undefined => labels[key];

  const description = pick('description', [
    ['spec', spec.description],
    ['readme', readme !== null ? readmeFirstParagraph(readme) : null],
    ['dockerfile', label(OCI_LABELS.description)],
  ]);
  const specSummary = pick('summary', [['spec', spec.summary]]);

  const byField: Record<PluginCatalogField, DetectedField> = {
    displayName: pick('displayName', [
      ['readme', readme !== null ? readmeTitle(readme) : null],
      ['dockerfile', label(OCI_LABELS.title)],
    ]),
    summary: specSummary.source !== null ? specSummary : derivedSummary(description.value),
    description,
    category: pick('category', [['spec', spec.category]]),
    keywords: pick('keywords', [['spec', spec.keywords]]),
    license: pick('license', [['spec', spec.license], ['dockerfile', label(OCI_LABELS.licenses)]]),
    homepageUrl: pick('homepageUrl', [['spec', spec.homepageUrl], ['dockerfile', label(OCI_LABELS.url)]]),
    sourceUrl: pick('sourceUrl', [['spec', spec.sourceUrl], ['dockerfile', label(OCI_LABELS.source)]]),
    documentationUrl: pick('documentationUrl', [['spec', spec.documentationUrl], ['dockerfile', label(OCI_LABELS.documentation)]]),
    icon: pick('icon', [['spec', spec.icon]]),
    changelog: pick('changelog', [['spec', spec.changelog]]),
    readme: pick('readme', [['readme', readme]]),
  };
  return PLUGIN_CATALOG_FIELDS.map((f) => byField[f]);
}

// -----------------------------------------------------------------------------
// Accept or edit
// -----------------------------------------------------------------------------

/**
 * Apply the user's edits over the detected values. A key present in `edits`
 * is the user's (`null` clears it) and is recorded as `user`; every other field
 * keeps its detected value (none when it failed validation). `edits` must
 * already have passed `PluginCatalogEditsSchema`. A summary that was DERIVED
 * from the description is re-derived when the user edited the description.
 */
export function resolveCatalogMetadata(detected: DetectedField[], edits: PluginCatalogEdits = {}): ResolvedCatalog {
  const values = {} as Record<PluginCatalogField, unknown>;
  const sources: MetadataSources = {};
  const set = (field: PluginCatalogField, value: unknown, source: MetadataSource | null): void => {
    values[field] = value ?? null;
    if (source && (value !== null && value !== undefined || source === 'user')) sources[field] = source;
  };

  for (const d of detected) {
    if (Object.prototype.hasOwnProperty.call(edits, d.field)) {
      set(d.field, (edits as Record<string, unknown>)[d.field], 'user');
    } else {
      set(d.field, d.error ? null : d.value, d.error ? null : d.source);
    }
  }

  const summaryDetected = detected.find((d) => d.field === 'summary');
  const summaryEdited = Object.prototype.hasOwnProperty.call(edits, 'summary');
  const descriptionEdited = Object.prototype.hasOwnProperty.call(edits, 'description');
  if (!summaryEdited && descriptionEdited && (summaryDetected?.source === 'derived' || summaryDetected?.source === null)) {
    const rederived = derivedSummary(values.description);
    delete sources.summary;
    set('summary', rederived.error ? null : rederived.value, rederived.error ? null : rederived.source);
  }
  return { values, sources };
}

/** A detection with every value accepted (no edits) — scripts, the Official loader. */
export function acceptAllCatalogMetadata(detected: DetectedField[]): ResolvedCatalog {
  return resolveCatalogMetadata(detected, {});
}

// -----------------------------------------------------------------------------
// Edit payloads
// -----------------------------------------------------------------------------

/**
 * Validate a catalog-edit payload (the upload's `metadata` part, already
 * JSON-decoded). Execution-contract keys are refused by name before the
 * strict schema runs, so the caller learns exactly which keys can't be edited.
 */
export function parseCatalogEdits(raw: unknown): { ok: true; value: PluginCatalogEdits } | { ok: false; error: string; contractKeys?: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'metadata must be a JSON object' };
  }
  const contractKeys = findContractKeys(raw);
  if (contractKeys.length > 0) return { ok: false, error: contractKeysMessage(contractKeys), contractKeys };
  const parsed = PluginCatalogEditsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid metadata: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, value: parsed.data };
}

/** Decode the upload's multipart `metadata` part (JSON text), then {@link parseCatalogEdits}. */
export function parseCatalogEditsPart(text: string | undefined): ReturnType<typeof parseCatalogEdits> {
  if (text === undefined || text.trim() === '') return { ok: true, value: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'metadata must be valid JSON' };
  }
  return parseCatalogEdits(raw);
}
