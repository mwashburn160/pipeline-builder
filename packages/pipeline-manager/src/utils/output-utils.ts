import fs from 'node:fs';
import path from 'node:path';
import pico from 'picocolors';
import YAML from 'yaml';
import {
  OutputFormat,
  formatFileSize,
  TABLE_OPTIONS,
} from '../config/cli.constants';

const { bold, cyan, green, yellow, red, dim, magenta, white } = pico;

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

/**
 * Options for outputData function
 */
export interface OutputOptions {
  format?: OutputFormat;
  file?: string;
  pretty?: boolean;
  silent?: boolean;
  append?: boolean;
}

/**
 * Table column configuration
 */
export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  formatter?: (value: any) => string;
}

// --- Logging functions ---

function logOutput(level: LogLevel, message: string, data?: unknown): void {
  const colors = { info: cyan, success: green, warn: yellow, error: red, debug: magenta };
  const prefixes = { info: 'ℹ', success: '✓', warn: '⚠', error: '✗', debug: '●' };
  const writers = { error: console.error, warn: console.warn, info: console.log, success: console.log, debug: console.log };

  const styledMessage = `${colors[level](prefixes[level])} ${message}`;
  const write = writers[level];

  write(styledMessage);
  if (data !== undefined) write(dim(formatDataForLog(data)));
}

function formatDataForLog(data: unknown): string {
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    const entries = Object.entries(data);
    if (entries.length <= 5) {
      return '\n' + entries.map(([key, value]) => {
        const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `  ${key}: ${valueStr}`;
      }).join('\n');
    }
  }
  return JSON.stringify(data, null, 2);
}

export function printSuccess(message: string, data?: unknown): void { logOutput('success', message, data); }
export function printInfo(message: string, data?: unknown): void { logOutput('info', message, data); }
export function printWarning(message: string, data?: unknown): void { logOutput('warn', message, data); }
export function printError(message: string, data?: unknown): void { logOutput('error', message, data); }

export function printDebug(message: string, data?: unknown): void {
  if (process.env.DEBUG === 'true') logOutput('debug', message, data);
}

// --- Data output ---

/**
 * Output data in specified format (console or file)
 */
export function outputData(data: unknown, options: OutputOptions = {}): void {
  const { format = 'json', file, pretty = true, silent = false, append = false } = options;

  let output: string;

  switch (format) {
    case 'table':
      if (!silent) printInfo('Rendering as table');
      if (Array.isArray(data) && data.length > 0) {
        console.log(formatTable(data));
      } else if (typeof data === 'object' && data !== null) {
        console.log(formatTable([data]));
      } else {
        console.table(Array.isArray(data) ? data : [data]);
      }
      return;

    case 'csv':
      if (!silent) printInfo('Rendering as CSV');
      output = formatCsv(data);
      break;

    case 'yaml':
      if (!silent) printInfo('Rendering as YAML');
      output = YAML.stringify(data);
      break;

    case 'json':
    default:
      if (!silent) printInfo('Rendering as JSON');
      output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      break;
  }

  if (file) {
    writeToFile(file, output, format, append);
  } else {
    console.log(output);
  }
}

// --- Table formatting ---

export function formatTable(data: unknown[], columns?: TableColumn[]): string {
  if (!Array.isArray(data) || data.length === 0) return dim('(No data to display)');

  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) return JSON.stringify(data, null, 2);

  const cols: TableColumn[] = columns || Object.keys(firstItem).map(key => ({ header: key, key }));

  const colWidths: number[] = cols.map(col => {
    if (col.width) return col.width;
    const headerWidth = col.header.length;
    const dataWidth = Math.max(...data.map(item => {
      const value = col.formatter
        ? col.formatter((item as any)[col.key])
        : String((item as any)[col.key] ?? '');
      return value.length;
    }));
    return Math.max(headerWidth, dataWidth, 3);
  });

  const { border } = TABLE_OPTIONS;

  const horizontalLine = (left: string, middle: string, right: string) =>
    left + colWidths.map(w => border.bodyJoin.repeat((w ?? 0) + 2)).join(middle) + right;

  const topLine = horizontalLine(border.topLeft, border.topJoin, border.topRight);
  const midLine = horizontalLine(border.joinLeft, border.joinJoin, border.joinRight);
  const bottomLine = horizontalLine(border.bottomLeft, border.bottomJoin, border.bottomRight);

  const formatCell = (value: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string => {
    if (value.length > width) return value.substring(0, width - 3) + '...';
    if (align === 'center') {
      const leftPad = Math.floor((width - value.length) / 2);
      return ' '.repeat(leftPad) + value + ' '.repeat(width - value.length - leftPad);
    }
    return align === 'right' ? value.padStart(width) : value.padEnd(width);
  };

  const headerRow = border.bodyLeft + ' ' +
    cols.map((col, i) => cyan(bold(formatCell(col.header, colWidths[i] ?? 0)))).join(` ${border.bodyJoin} `) +
    ` ${border.bodyRight}`;

  let table = cyan(topLine) + '\n' + headerRow + '\n' + cyan(midLine) + '\n';

  data.forEach(item => {
    const row = border.bodyLeft + ' ' +
      cols.map((col, i) => {
        const value = col.formatter
          ? col.formatter((item as any)[col.key])
          : String((item as any)[col.key] ?? '');
        return formatCell(value, colWidths[i] ?? 0, col.align);
      }).join(` ${border.bodyJoin} `) +
      ` ${border.bodyRight}`;
    table += row + '\n';
  });

  table += cyan(bottomLine);
  return table;
}

// --- CSV formatting ---

function formatCsv(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) return '';
  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) return data.join(',');

  const headers = Object.keys(firstItem);
  const rows: string[] = [headers.map(h => escapeCsvValue(h)).join(',')];
  data.forEach(item => {
    rows.push(headers.map(h => escapeCsvValue((item as any)[h])).join(','));
  });
  return rows.join('\n');
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// --- File operations ---

function writeToFile(filePath: string, content: string, format: OutputFormat, append: boolean = false): void {
  try {
    const dir = path.dirname(filePath);
    if (dir !== '.') ensureOutputDirectory(dir);

    if (append) {
      fs.appendFileSync(filePath, content + '\n', 'utf-8');
      printSuccess('Output appended to file', { path: filePath, format });
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
      const stats = fs.statSync(filePath);
      printSuccess('Output saved to file', { path: filePath, format, size: formatFileSize(stats.size) });
    }
  } catch (error) {
    printError('Failed to write file', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function ensureOutputDirectory(outputPath: string): void {
  if (fs.existsSync(outputPath)) return;
  try {
    fs.mkdirSync(outputPath, { recursive: true });
    printDebug('Directory created', { path: outputPath });
  } catch (error) {
    printError('Failed to create directory', {
      path: outputPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// --- Display helpers ---

export function printSection(title: string, subtitle?: string): void {
  const width = process.stdout.columns || 80;
  console.log('');
  console.log(cyan('═'.repeat(width)));
  console.log(cyan(bold(title)));
  if (subtitle) console.log(dim(subtitle));
  console.log(cyan('═'.repeat(width)));
}

export function printKeyValue(
  data: Record<string, unknown>,
  options: { indent?: number; separator?: string } = {},
): void {
  const { indent = 0, separator = '│' } = options;
  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));
  const indentStr = ' '.repeat(indent);

  Object.entries(data).forEach(([key, value]) => {
    const paddedKey = key.padEnd(maxKeyLength);
    const formattedValue = typeof value === 'object' && value !== null
      ? JSON.stringify(value) : String(value);
    console.log(`${indentStr}${dim(paddedKey)} ${cyan(separator)} ${white(formattedValue)}`);
  });
}

export function printDivider(char: string = '─', width?: number): void {
  const effectiveWidth = width || process.stdout.columns || 80;
  console.log(dim(char.repeat(effectiveWidth)));
}

// --- Response parsing ---

export interface ListResponseResult<T> {
  items: T[];
  total?: number;
  hasMore: boolean;
}

/**
 * Extract items from an API list response, handling multiple response formats.
 * Supports: `{ <key>: T[] }`, `{ items: T[] }`, `T[]`, or invalid formats.
 */
export function extractListResponse<T>(response: unknown, itemsKey: string): ListResponseResult<T> {
  if (Array.isArray(response)) {
    return { items: response, total: undefined, hasMore: false };
  }

  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;

    // Try primary key (e.g. 'pipelines', 'plugins')
    if (itemsKey in obj && Array.isArray(obj[itemsKey])) {
      return { items: obj[itemsKey] as T[], total: obj.total as number | undefined, hasMore: (obj.hasMore as boolean) || false };
    }

    // Try generic 'items' key
    if ('items' in obj && Array.isArray(obj.items)) {
      return { items: obj.items as T[], total: obj.total as number | undefined, hasMore: (obj.hasMore as boolean) || false };
    }

    printWarning('Unexpected response format, attempting to handle');
    return { items: [], total: undefined, hasMore: false };
  }

  printError('Invalid response format from API');
  throw new Error('Unexpected API response format');
}
