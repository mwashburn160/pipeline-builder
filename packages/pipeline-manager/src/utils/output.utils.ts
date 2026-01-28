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

/**
 * Log level for output messages
 */
export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

/**
 * Options for outputData function
 */
export interface OutputOptions {
  /**
   * Output format
   * @default 'json'
   */
  format?: OutputFormat;

  /**
   * File path to write output to (optional)
   */
  file?: string;

  /**
   * Pretty print JSON/YAML
   * @default true
   */
  pretty?: boolean;

  /**
   * Show output message
   * @default true
   */
  silent?: boolean;

  /**
   * Append to file instead of overwriting
   * @default false
   */
  append?: boolean;
}

/**
 * Table column configuration
 */
export interface TableColumn {
  /**
   * Column header text
   */
  header: string;

  /**
   * Column key (property name)
   */
  key: string;

  /**
   * Column width (optional, auto-calculated if not provided)
   */
  width?: number;

  /**
   * Column alignment
   * @default 'left'
   */
  align?: 'left' | 'center' | 'right';

  /**
   * Value formatter function
   */
  formatter?: (value: any) => string;
}

/**
 * Progress bar options
 */
export interface ProgressBarOptions {
  /**
   * Total value (100%)
   */
  total: number;

  /**
   * Current value
   */
  current: number;

  /**
   * Bar width in characters
   * @default 20
   */
  width?: number;

  /**
   * Show percentage
   * @default true
   */
  showPercentage?: boolean;

  /**
   * Bar color
   * @default 'cyan'
   */
  color?: 'cyan' | 'green' | 'yellow' | 'red';
}

/**
 * Log output message with color coding
 *
 * @param level - Log level
 * @param message - Message to log
 * @param data - Optional data object
 */
function logOutput(level: LogLevel, message: string, data?: unknown): void {
  const colors = {
    info: cyan,
    success: green,
    warn: yellow,
    error: red,
    debug: magenta,
  };

  const prefixes = {
    info: 'ℹ',
    success: '✓',
    warn: '⚠',
    error: '✗',
    debug: '●',
  };

  const color = colors[level];
  const prefix = prefixes[level];
  const styledMessage = `${color(prefix)} ${message}`;

  if (level === 'error') {
    console.error(styledMessage);
    if (data !== undefined) {
      console.error(dim(formatDataForLog(data)));
    }
  } else if (level === 'warn') {
    console.warn(styledMessage);
    if (data !== undefined) {
      console.warn(dim(formatDataForLog(data)));
    }
  } else {
    console.log(styledMessage);
    if (data !== undefined) {
      console.log(dim(formatDataForLog(data)));
    }
  }
}

/**
 * Format data for logging
 */
function formatDataForLog(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'object' && data !== null) {
    // If it's a simple object with few keys, format as key: value
    const entries = Object.entries(data);
    if (entries.length <= 5) {
      return '\n' + entries.map(([key, value]) => {
        const valueStr = typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
        return `  ${key}: ${valueStr}`;
      }).join('\n');
    }
  }

  // Otherwise, use JSON
  return JSON.stringify(data, null, 2);
}

/**
 * Output data in specified format
 *
 * @param data - Data to output
 * @param options - Output options
 *
 * @example
 * ```typescript
 * // Console output as JSON
 * outputData(pipeline, { format: 'json' });
 *
 * // Save to file as YAML
 * outputData(pipeline, { format: 'yaml', file: './output.yaml' });
 *
 * // Table format
 * outputData([plugin1, plugin2], { format: 'table' });
 *
 * // CSV format
 * outputData([plugin1, plugin2], { format: 'csv', file: 'data.csv' });
 * ```
 */
export function outputData(data: unknown, options: OutputOptions = {}): void {
  const { format = 'json', file, pretty = true, silent = false, append = false } = options;

  let output: string;

  // Generate output based on format
  switch (format) {
    case 'table':
      if (!silent) {
        printInfo('Rendering as table');
      }
      if (Array.isArray(data) && data.length > 0) {
        console.log(formatTable(data));
      } else if (typeof data === 'object' && data !== null) {
        console.log(formatTable([data]));
      } else {
        console.table(Array.isArray(data) ? data : [data]);
      }
      return; // Table format doesn't support file output

    case 'csv':
      if (!silent) {
        printInfo('Rendering as CSV');
      }
      output = formatCsv(data);
      break;

    case 'yaml':
      if (!silent) {
        printInfo('Rendering as YAML');
      }
      output = YAML.stringify(data);
      break;

    case 'json':
    default:
      if (!silent) {
        printInfo('Rendering as JSON');
      }
      output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      break;
  }

  // Write to file or console
  if (file) {
    writeToFile(file, output, format, append);
  } else {
    console.log(output);
  }
}

/**
 * Format data as CSV
 *
 * @param data - Data to format
 * @returns CSV string
 */
function formatCsv(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) {
    return data.join(',');
  }

  const headers = Object.keys(firstItem);
  const csvRows: string[] = [];

  // Add header row
  csvRows.push(headers.map(h => escapeCsvValue(h)).join(','));

  // Add data rows
  data.forEach(item => {
    const row = headers.map(header => {
      const value = (item as any)[header];
      return escapeCsvValue(value);
    });
    csvRows.push(row.join(','));
  });

  return csvRows.join('\n');
}

/**
 * Escape CSV value
 */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);

  // If value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Write output to file
 *
 * @param filePath - Path to file
 * @param content - Content to write
 * @param format - Output format
 * @param append - Append to file instead of overwriting
 */
function writeToFile(
  filePath: string,
  content: string,
  format: OutputFormat,
  append: boolean = false,
): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (dir !== '.') {
      ensureOutputDirectory(dir);
    }

    // Write or append file
    if (append) {
      fs.appendFileSync(filePath, content + '\n', 'utf-8');
      printSuccess('Output appended to file', { path: filePath, format });
    } else {
      fs.writeFileSync(filePath, content, 'utf-8');
      const stats = fs.statSync(filePath);
      printSuccess('Output saved to file', {
        path: filePath,
        format,
        size: formatFileSize(stats.size),
      });
    }
  } catch (error) {
    printError('Failed to write file', {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Ensure output directory exists
 *
 * @param outputPath - Directory path to create
 *
 * @example
 * ```typescript
 * ensureOutputDirectory('./output/logs');
 * ```
 */
export function ensureOutputDirectory(outputPath: string): void {
  if (fs.existsSync(outputPath)) {
    return;
  }

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

/**
 * Read data from file
 *
 * @param filePath - Path to file
 * @param format - Expected format (json, yaml)
 * @returns Parsed data
 *
 * @example
 * ```typescript
 * const config = readFromFile('./config.yaml', 'yaml');
 * const data = readFromFile<MyType>('./data.json', 'json');
 * ```
 */
export function readFromFile<T = unknown>(filePath: string, format: 'json' | 'yaml' = 'json'): T {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    if (format === 'yaml') {
      return YAML.parse(content) as T;
    } else {
      return JSON.parse(content) as T;
    }
  } catch (error) {
    printError('Failed to read file', {
      path: filePath,
      format,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Format data as table string
 *
 * @param data - Data to format
 * @param columns - Optional column configuration
 * @returns Formatted table string
 *
 * @example
 * ```typescript
 * const table = formatTable(items);
 * console.log(table);
 *
 * // With custom columns
 * const table = formatTable(items, [
 *   { header: 'Name', key: 'name', width: 20 },
 *   { header: 'Status', key: 'status', align: 'center' }
 * ]);
 * ```
 */
export function formatTable(data: unknown[], columns?: TableColumn[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return dim('(No data to display)');
  }

  // Get headers from first object or use provided columns
  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) {
    return JSON.stringify(data, null, 2);
  }

  const cols: TableColumn[] = columns || Object.keys(firstItem).map(key => ({
    header: key,
    key,
  }));

  // Calculate column widths if not provided
  const colWidths: number[] = cols.map(col => {
    if (col.width) return col.width;

    const headerWidth = col.header.length;
    const dataWidth = Math.max(...data.map(item => {
      const value = col.formatter
        ? col.formatter((item as any)[col.key])
        : String((item as any)[col.key] ?? '');
      return value.length;
    }));

    return Math.max(headerWidth, dataWidth, 3); // Minimum width of 3
  });

  // Build table with box drawing characters
  const { border } = TABLE_OPTIONS;

  const horizontalLine = (left: string, middle: string, right: string) => {
    return left + colWidths.map(w => border.bodyJoin.repeat((w ?? 0) + 2)).join(middle) + right;
  };

  const topLine = horizontalLine(border.topLeft, border.topJoin, border.topRight);
  const midLine = horizontalLine(border.joinLeft, border.joinJoin, border.joinRight);
  const bottomLine = horizontalLine(border.bottomLeft, border.bottomJoin, border.bottomRight);

  // Format cell value with alignment
  const formatCell = (value: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string => {
    if (value.length > width) {
      return value.substring(0, width - 3) + '...';
    }

    if (align === 'center') {
      const leftPad = Math.floor((width - value.length) / 2);
      const rightPad = width - value.length - leftPad;
      return ' '.repeat(leftPad) + value + ' '.repeat(rightPad);
    } else if (align === 'right') {
      return value.padStart(width);
    } else {
      return value.padEnd(width);
    }
  };

  // Header row
  const headerRow = border.bodyLeft + ' ' +
    cols.map((col, i) =>
      cyan(bold(formatCell(col.header, colWidths[i] ?? 0))),
    ).join(` ${border.bodyJoin} `) +
    ` ${border.bodyRight}`;

  let table = cyan(topLine) + '\n';
  table += headerRow + '\n';
  table += cyan(midLine) + '\n';

  // Data rows
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

/**
 * Print colored success message
 *
 * @param message - Message to print
 * @param data - Optional data to display
 */
export function printSuccess(message: string, data?: unknown): void {
  logOutput('success', message, data);
}

/**
 * Print colored info message
 *
 * @param message - Message to print
 * @param data - Optional data to display
 */
export function printInfo(message: string, data?: unknown): void {
  logOutput('info', message, data);
}

/**
 * Print colored warning message
 *
 * @param message - Message to print
 * @param data - Optional data to display
 */
export function printWarning(message: string, data?: unknown): void {
  logOutput('warn', message, data);
}

/**
 * Alias for printWarning (backwards compatibility)
 */
export function printWarn(message: string, data?: unknown): void {
  printWarning(message, data);
}

/**
 * Print colored error message
 *
 * @param message - Message to print
 * @param data - Optional data to display
 */
export function printError(message: string, data?: unknown): void {
  logOutput('error', message, data);
}

/**
 * Print debug message (only in debug mode)
 *
 * @param message - Message to print
 * @param data - Optional data to display
 */
export function printDebug(message: string, data?: unknown): void {
  if (process.env.DEBUG === 'true') {
    logOutput('debug', message, data);
  }
}

/**
 * Check if file exists
 *
 * @param filePath - Path to check
 * @returns true if file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Check if path is a directory
 *
 * @param dirPath - Path to check
 * @returns true if path is a directory
 */
export function isDirectory(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Get file size
 *
 * @param filePath - Path to file
 * @returns File size in bytes
 */
export function getFileSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

/**
 * Delete file if it exists
 *
 * @param filePath - Path to file
 */
export function deleteFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      printDebug('File deleted', { path: filePath });
    } catch (error) {
      printError('Failed to delete file', {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

/**
 * Copy file
 *
 * @param sourcePath - Source file path
 * @param destPath - Destination file path
 */
export function copyFile(sourcePath: string, destPath: string): void {
  try {
    const dir = path.dirname(destPath);
    ensureOutputDirectory(dir);
    fs.copyFileSync(sourcePath, destPath);
    printDebug('File copied', { from: sourcePath, to: destPath });
  } catch (error) {
    printError('Failed to copy file', {
      from: sourcePath,
      to: destPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Print a section header
 *
 * @param title - Section title
 * @param subtitle - Optional subtitle
 *
 * @example
 * ```typescript
 * printSection('Deployment');
 * printSection('Configuration', 'Loading settings...');
 * ```
 */
export function printSection(title: string, subtitle?: string): void {
  const width = process.stdout.columns || 80;
  console.log('');
  console.log(cyan('═'.repeat(width)));
  console.log(cyan(bold(title)));
  if (subtitle) {
    console.log(dim(subtitle));
  }
  console.log(cyan('═'.repeat(width)));
}

/**
 * Print key-value pairs in a formatted way
 *
 * @param data - Object with key-value pairs
 * @param options - Formatting options
 *
 * @example
 * ```typescript
 * printKeyValue({
 *   'Pipeline ID': 'pipe-123',
 *   'Status': 'Active',
 *   'Created': '2024-01-27',
 * });
 * ```
 */
export function printKeyValue(
  data: Record<string, unknown>,
  options: {
    indent?: number;
    separator?: string;
    keyColor?: typeof cyan;
    valueColor?: typeof white;
  } = {},
): void {
  const {
    indent = 0,
    separator = '│',
    keyColor = dim,
    valueColor = white,
  } = options;

  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));
  const indentStr = ' '.repeat(indent);

  Object.entries(data).forEach(([key, value]) => {
    const paddedKey = key.padEnd(maxKeyLength);
    const formattedValue = typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value);
    console.log(`${indentStr}${keyColor(paddedKey)} ${cyan(separator)} ${valueColor(formattedValue)}`);
  });
}

/**
 * Print a divider line
 *
 * @param char - Character to use for divider
 * @param width - Width of divider (default: terminal width)
 *
 * @example
 * ```typescript
 * printDivider();
 * printDivider('═');
 * printDivider('─', 50);
 * ```
 */
export function printDivider(char: string = '─', width?: number): void {
  const effectiveWidth = width || process.stdout.columns || 80;
  console.log(dim(char.repeat(effectiveWidth)));
}

/**
 * Print a progress bar
 *
 * @param options - Progress bar options
 *
 * @example
 * ```typescript
 * printProgressBar({
 *   current: 50,
 *   total: 100,
 *   width: 30,
 *   showPercentage: true,
 * });
 * // Output: [███████████████░░░░░░░░░░░░░░░] 50%
 * ```
 */
export function printProgressBar(options: ProgressBarOptions): void {
  const {
    total,
    current,
    width = 20,
    showPercentage = true,
    color = 'cyan',
  } = options;

  const percentage = Math.min(100, Math.max(0, (current / total) * 100));
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;

  const colorMap = {
    cyan,
    green,
    yellow,
    red,
  } as const;

  const colorFn = colorMap[color];

  const bar = colorFn('█'.repeat(filled)) + dim('░'.repeat(empty));
  const percentageStr = showPercentage ? ` ${percentage.toFixed(1)}%` : '';

  console.log(`[${bar}]${percentageStr}`);
}

/**
 * Print a list of items
 *
 * @param items - Items to list
 * @param options - List options
 *
 * @example
 * ```typescript
 * printList(['Item 1', 'Item 2', 'Item 3'], { bullet: '→', color: 'cyan' });
 * ```
 */
export function printList(
  items: string[],
  options: {
    bullet?: string;
    color?: 'cyan' | 'green' | 'yellow' | 'white';
    indent?: number;
    numbered?: boolean;
  } = {},
): void {
  const {
    bullet = '•',
    color = 'cyan',
    indent = 0,
    numbered = false,
  } = options;

  const colorMap = { cyan, green, yellow, white } as const;
  const colorFn = colorMap[color];
  const indentStr = ' '.repeat(indent);

  items.forEach((item, index) => {
    const prefix = numbered ? `${index + 1}.` : bullet;
    console.log(indentStr + colorFn(prefix) + ' ' + item);
  });
}

/**
 * Create a spinner (for use with ora or similar)
 * This is a helper to show a simple spinner character
 *
 * @param message - Message to display
 * @param frame - Spinner frame index
 *
 * @example
 * ```typescript
 * const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
 * printSpinner('Loading...', 0);
 * ```
 */
export function printSpinner(message: string, frame: number = 0): void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinnerChar = frames[frame % frames.length];
  process.stdout.write(`\r${cyan(spinnerChar!)} ${message}`);
}

/**
 * Clear the current line (useful for updating spinners)
 */
export function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

/**
 * Print a box around text
 *
 * @param text - Text to box
 * @param options - Box options
 *
 * @example
 * ```typescript
 * printBox('Important Message', { padding: 1, color: 'yellow' });
 * ```
 */
export function printBox(
  text: string,
  options: {
    padding?: number;
    color?: 'cyan' | 'green' | 'yellow' | 'red';
  } = {},
): void {
  const { padding = 0, color = 'cyan' } = options;
  const colorMap = { cyan, green, yellow, red } as const;
  const colorFn = colorMap[color];

  const lines = text.split('\n');
  const maxLength = Math.max(...lines.map(l => l.length));
  const width = maxLength + (padding * 2) + 2;

  const top = '┌' + '─'.repeat(width) + '┐';
  const bottom = '└' + '─'.repeat(width) + '┘';
  const empty = '│' + ' '.repeat(width) + '│';

  console.log(colorFn(top));

  for (let i = 0; i < padding; i++) {
    console.log(colorFn(empty));
  }

  lines.forEach(line => {
    const padded = ' '.repeat(padding) + line.padEnd(maxLength) + ' '.repeat(padding);
    console.log(colorFn('│ ' + padded + ' │'));
  });

  for (let i = 0; i < padding; i++) {
    console.log(colorFn(empty));
  }

  console.log(colorFn(bottom));
}
