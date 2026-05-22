// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CSV export utility — extracted so list pages outside the reports
 * namespace can export their tables without pulling reports-specific UI
 * helpers. ReportHelpers.ExportCSVButton stays as the report-styled
 * button; this module exposes the headless `downloadCsv` and a
 * tighter, more generic button (`<DownloadCsvButton />`) below.
 *
 * Formula-injection defense: Excel/LibreOffice treat leading `=`, `+`,
 * `-`, `@`, tab, or CR as formula starters. If a user names a pipeline
 * `=cmd|'/c calc'` and an operator opens the export in Excel, the
 * formula executes. We prefix any such cell with a leading apostrophe
 * so the spreadsheet renders it as literal text.
 */

function escapeCsvCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function toCsvRow(values: ReadonlyArray<unknown>): string {
  return values.map((v) => {
    const raw = v === null || v === undefined ? '' : String(v);
    const str = escapeCsvCell(raw);
    return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(',');
}

/**
 * Render `rows` as CSV and trigger a browser download.
 *
 * - `headers` controls column order. Cells not present in a row become empty strings.
 * - `filename` is appended with `.csv` if missing.
 * - Returns the row count emitted (0 if rows was empty).
 */
export function downloadCsv<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
  headers: ReadonlyArray<string>,
  filename: string,
): number {
  if (rows.length === 0) return 0;
  const headerLine = toCsvRow(headers);
  const dataLines = rows.map((row) => toCsvRow(headers.map((h) => row[h])));
  const csv = [headerLine, ...dataLines].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return rows.length;
}

/** Same idea, but emits JSON Lines (one row per line) instead of CSV. */
export function downloadJsonl<T>(
  rows: ReadonlyArray<T>,
  filename: string,
): number {
  if (rows.length === 0) return 0;
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  const blob = new Blob([body], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.jsonl') ? filename : `${filename}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return rows.length;
}
