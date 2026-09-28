// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The snapshot, as one self-contained HTML document — the input the PDF renderer prints.
 *
 * WHY HTML AND NOT A PDF LIBRARY. A layout engine we would have to teach about page
 * breaks, table widths and font metrics is a second renderer to maintain; Chromium
 * already has one. So the pipeline is snapshot -> HTML -> `Page.printToPDF`, and this
 * file owns the first arrow. It is pure: a string in, a string out, no I/O, no clock, no
 * database. That is what makes the PDF's content testable without a browser.
 *
 * SELF-CONTAINED, AND THAT IS A SECURITY PROPERTY, not tidiness. No <script>, no
 * stylesheet link, no web font, no image URL — everything is inline. The renderer loads
 * this through `setContent` with the page offline, so a document that referenced anything
 * external would either hang or quietly render without it. Stated here because the
 * temptation to add a logo by URL will come up, and it would be the one change that gives
 * the renderer a reason to talk to the network.
 *
 * EVERY INTERPOLATION IS ESCAPED. The snapshot carries org-controlled text — pipeline
 * names, a lead's notes, a section title — into markup that a browser then parses. That
 * is the same boundary as any XSS sink, and it does not stop mattering because the output
 * is a PDF: unescaped notes could close a tag and rewrite the rest of the report, which is
 * a document-forgery bug in a document people make decisions from. `esc()` is applied at
 * every single insertion point and there is no "trusted" caller.
 *
 * NO COLOUR-ONLY MEANING, and no bare glyph carrying information (WCAG 1.4.1 / 1.1.1). A
 * locked panel says "Not on your plan" in words; a trend says "down 3 points" in words
 * rather than leaning on an arrow. There are no charts in a snapshot today — every section
 * renders as a number, a word and a table row — so the plan's "alt text on charts" has
 * nothing to attach to yet. The rule that replaces it is stricter and survives a chart
 * being added later: if a reader with no colour vision, no images and a screen reader
 * cannot get a fact out of this document, the fact is not in it.
 */

import type { ComposedSection, DataQualityNote, ReportSnapshot } from './compose.js';

/** What the renderer needs to produce one report document. */
export interface ReportHtmlInput {
  /** The definition's name. Heads the document. */
  title: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  /** Regenerations are normal; a reader must be able to tell which one they hold. */
  version: number;
  publishedAt?: string | null;
  /** The lead's own words. Rendered ABOVE the numbers — see the ordering note below. */
  leadNotes?: string | null;
  /**
   * The AI-drafted executive summary, when the run has one and the caller is allowed to
   * see it. Never fetched here: a caller that should not disclose it simply omits it.
   */
  executiveSummary?: string | null;
  snapshot: ReportSnapshot | null;
  /** True when pipeline/project names were replaced — said in the document, not implied. */
  namesRedacted?: boolean;
  /** Shown in the footer of a shared copy, so a bookmarked link's death is not a surprise. */
  expiresAt?: string | null;
  /**
   * Stamped in the footer as the moment the FILE was made, distinct from the snapshot's
   * own `generatedAt`. Two dates because they answer different questions: "is this report
   * current?" and "is this the copy I was sent?".
   */
  renderedAt: string;
}

/** HTML-escape. Applied at every insertion point; see the file header. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A date as a plain calendar day, in UTC, or `—` when absent. */
function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * The trend, IN WORDS.
 *
 * "down 3 points" rather than a red arrow, because the arrow is the whole fact for a
 * section whose headline barely moved, and an arrow is invisible to a screen reader and
 * ambiguous in greyscale. `unknown` renders nothing at all rather than "flat" — a section
 * with no comparable previous period has not held steady, we just cannot say.
 */
export function trendSentence(section: ComposedSection): string | null {
  const { change, headline } = section;
  if (!change || change.direction === 'unknown') return null;
  const unit = headline?.unit === '%' ? 'points' : null;
  const magnitude = Math.abs(change.absolute);
  if (change.direction === 'flat') return 'unchanged from the previous period';
  const word = change.direction === 'up' ? 'up' : 'down';
  const pct = change.percent !== null && change.percent !== undefined
    ? ` (${change.percent > 0 ? '+' : ''}${change.percent}%)`
    : '';
  return `${word} ${magnitude}${unit ? ` ${unit}` : ''}${pct} from the previous period`;
}

/**
 * One section as a table row.
 *
 * A TABLE, not a grid of cards, because that is what makes the PDF's structure tree
 * navigable: a screen reader announces "Build success rate, 91%, down 3 points from the
 * previous period" from the row's association with its headers. Cards would print the
 * same ink and carry none of that.
 */
function sectionRow(section: ComposedSection): string {
  const title = esc(section.title);
  if (section.state === 'locked') {
    const feature = section.requiresFeature ? esc(section.requiresFeature) : 'an add-on';
    return `<tr><th scope="row">${title}</th>`
      + '<td class="muted">Not included</td>'
      + `<td class="muted">Not on your plan — needs ${feature}. The rest of this report is unaffected.</td></tr>`;
  }
  if (section.state === 'failed') {
    return `<tr><th scope="row">${title}</th>`
      + '<td class="muted">Unavailable</td>'
      + '<td class="muted">Could not be computed for this period.</td></tr>';
  }
  const { headline } = section;
  // A section with no single number is not an error and must not read like one: several
  // legitimately have none (a breakdown, a list of offenders).
  const value = headline
    ? `${esc(headline.value)}${esc(headline.unit ?? '')}`
    : '—';
  const label = headline?.label ? esc(headline.label) : 'No single headline for this section';
  const trend = trendSentence(section);
  const note = trend ? `${label} · ${esc(trend)}` : label;
  return `<tr><th scope="row">${title}</th><td class="value">${value}</td><td>${note}</td></tr>`;
}

/** The data-quality notes, which are the difference between "0 deploys" and "we cannot see your deploys". */
function notesList(notes: readonly DataQualityNote[]): string {
  if (notes.length === 0) return '';
  const items = notes.map((n) => `<li>${esc(n.message)}</li>`).join('');
  return '<section class="block"><h2>What to know about these numbers</h2>'
    + `<ul class="notes">${items}</ul></section>`;
}

/**
 * Paragraphs from free text.
 *
 * Blank-line separated, and NOT a single `<p>` with newlines: a lead who wrote three
 * paragraphs gets three, and the PDF's structure tree gets three, instead of one wall
 * that a screen reader reads as a single utterance.
 */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

/**
 * The print stylesheet.
 *
 * Deliberately small and deliberately not the product's design system: this document is
 * printed once, to paper size, by one engine. Importing the app's CSS would drag in a web
 * font (a network fetch the renderer forbids) and a dark-mode block that would render a
 * manager's PDF black.
 *
 * `@page` owns the margins so Chromium's own `margin` option does not have to, which keeps
 * the page geometry in the document rather than split across two places.
 */
const STYLE = `
:root { color-scheme: only light; }
* { box-sizing: border-box; }
@page { size: A4; margin: 18mm 16mm 20mm; }
body {
  margin: 0; background: #ffffff; color: #111827;
  font: 11pt/1.45 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
h1 { font-size: 20pt; margin: 0 0 2mm; }
h2 { font-size: 12pt; margin: 0 0 2mm; }
p { margin: 0 0 2.5mm; }
.sub { color: #4b5563; font-size: 9.5pt; margin: 0 0 6mm; }
.block { margin: 0 0 7mm; page-break-inside: avoid; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
caption { text-align: left; font-weight: 600; font-size: 12pt; padding: 0 0 2mm; }
th, td { text-align: left; vertical-align: top; padding: 2mm 2mm 2mm 0; border-bottom: 1px solid #e5e7eb; }
thead th { border-bottom: 1.5px solid #9ca3af; font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; }
tbody th { font-weight: 600; width: 42%; }
td.value { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; width: 18%; }
.muted { color: #4b5563; }
.notes { margin: 0; padding-left: 5mm; }
.notes li { margin: 0 0 1.5mm; }
.footer { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #e5e7eb; color: #4b5563; font-size: 8.5pt; }
.footer p { margin: 0 0 1mm; }
tr { page-break-inside: avoid; }
`;

/**
 * Render one report as a complete HTML document.
 *
 * ORDER IS MEANING, and it is the same order the shared web page uses: the lead's words,
 * then the executive summary, then the numbers. A reader who meets the table first has
 * already formed a view of the dip by the time they reach the sentence explaining it, so
 * the context the data cannot supply has to come first. `a11y-stakeholder-reports.test.tsx`
 * pins that ordering for the page; `report-html.test.ts` pins it here.
 *
 * A NULL SNAPSHOT STILL RENDERS. A run can be read before or without a snapshot (a failed
 * compose, a draft), and answering an empty file would look like a broken download. The
 * document says there is nothing to show instead.
 */
export function renderReportHtml(input: ReportHtmlInput): string {
  const snapshot = input.snapshot;
  const sections = snapshot?.sections ?? [];
  const lang = 'en';

  const head = [
    '<!DOCTYPE html>',
    `<html lang="${lang}"><head><meta charset="utf-8" />`,
    // No external anything: the one directive that makes the promise in the file header
    // enforceable by the engine rather than by review.
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'" />',
    `<title>${esc(input.title)} — ${esc(input.periodLabel)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
  ].join('');

  const version = input.version > 1 ? ` · revision ${esc(input.version)}` : '';
  const published = input.publishedAt ? ` · published ${esc(day(input.publishedAt))}` : '';
  const header = `<h1>${esc(input.title)}</h1>`
    + `<p class="sub">${esc(input.periodLabel)} · ${esc(day(input.periodStart))} to `
    + `${esc(day(input.periodEnd))}${version}${published}</p>`;

  const summary = input.executiveSummary
    ? `<section class="block"><h2>Executive summary</h2>${paragraphs(input.executiveSummary)}</section>`
    : '';

  const notes = input.leadNotes
    ? `<section class="block"><h2>Notes from the team</h2>${paragraphs(input.leadNotes)}</section>`
    : '';

  const body = sections.length > 0
    ? '<section class="block"><table>'
      + `<caption>Delivery measures for ${esc(input.periodLabel)}</caption>`
      + '<thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Detail</th></tr></thead>'
      + `<tbody>${sections.map(sectionRow).join('')}</tbody></table></section>`
    : '<section class="block"><h2>No measures</h2>'
      + '<p class="muted">This report has no computed sections. Nothing was measured for this period.</p></section>';

  const footerLines: string[] = [];
  if (input.namesRedacted) {
    footerLines.push('Project and pipeline names have been replaced in this copy.');
  }
  if (snapshot?.methodology) footerLines.push(snapshot.methodology);
  if (snapshot?.generatedAt) {
    footerLines.push(`Figures computed ${day(snapshot.generatedAt)} and frozen for the period shown.`);
  }
  if (input.expiresAt) {
    footerLines.push(`The link this copy came from expires on ${day(input.expiresAt)}.`);
  }
  footerLines.push(`This file was created ${day(input.renderedAt)}.`);
  const footer = `<footer class="footer">${footerLines.map((l) => `<p>${esc(l)}</p>`).join('')}</footer>`;

  return `${head}${header}${notes}${summary}${body}${notesList(snapshot?.notes ?? [])}${footer}</body></html>`;
}

/**
 * The download's file name.
 *
 * Built from the period and the version rather than the run id, because the person saving
 * it is filing it next to last month's, and `report-2026-W38-v2.pdf` sorts and reads while
 * a uuid does not. Sanitizing is the ROUTE's job (`attachmentDisposition`) — this only
 * chooses the words.
 */
export function reportFileName(title: string, periodLabel: string, version: number): string {
  const base = `${title} ${periodLabel}${version > 1 ? ` v${version}` : ''}`;
  return `${base.trim()}.pdf`;
}
