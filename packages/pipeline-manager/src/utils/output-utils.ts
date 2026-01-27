import fs from 'node:fs';
import path from 'node:path';
import pico from 'picocolors';
import YAML from 'yaml';

const { bold, cyan, green, yellow, red, dim, magenta } = pico;

/**
 * Output format types
 */
export type OutputFormat = 'table' | 'json' | 'yaml';

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
   */
  format?: OutputFormat;

  /**
   * File path to write output to (optional)
   */
  file?: string;

  /**
   * Pretty print JSON/YAML (default: true)
   */
  pretty?: boolean;

  /**
   * Show output message (default: true)
   */
  silent?: boolean;
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
      console.error(dim(JSON.stringify(data, null, 2)));
    }
  } else if (level === 'warn') {
    console.warn(styledMessage);
    if (data !== undefined) {
      console.warn(dim(JSON.stringify(data, null, 2)));
    }
  } else {
    console.log(styledMessage);
    if (data !== undefined) {
      console.log(dim(JSON.stringify(data, null, 2)));
    }
  }
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
 * ```
 */
export function outputData(data: unknown, options: OutputOptions = {}): void {
  const { format = 'json', file, pretty = true, silent = false } = options;

  let output: string;

  // Generate output based on format
  switch (format) {
    case 'table':
      if (!silent) {
        printInfo('Rendering as table');
      }
      if (Array.isArray(data) && data.length > 0) {
        console.log(formatTable(data));
      } else {
        console.table(Array.isArray(data) ? data : [data]);
      }
      return; // Table format doesn't support file output

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
    writeToFile(file, output, format);
  } else {
    console.log(output);
  }
}

/**
 * Write output to file
 *
 * @param filePath - Path to file
 * @param content - Content to write
 * @param format - Output format
 */
function writeToFile(filePath: string, content: string, format: OutputFormat): void {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (dir !== '.') {
      ensureOutputDirectory(dir);
    }

    // Write file
    fs.writeFileSync(filePath, content, 'utf-8');
    printSuccess('Output saved to file', { path: filePath, format });
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
    printInfo('Directory created', { path: outputPath });
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
 * Format data as table string (for logging)
 *
 * @param data - Data to format
 * @returns Formatted table string
 */
export function formatTable(data: unknown[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return dim('(No data to display)');
  }

  // Get headers from first object
  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null) {
    return JSON.stringify(data, null, 2);
  }

  const headers = Object.keys(firstItem);
  const colWidths = headers.map(h => h.length);

  // Calculate column widths
  data.forEach(item => {
    headers.forEach((header, i) => {
      const value = String((item as any)[header] ?? '');
      const currentWidth = colWidths[i] ?? 0;
      colWidths[i] = Math.max(currentWidth, value.length);
    });
  });

  // Build table with box drawing characters
  const horizontalLine = (left: string, middle: string, right: string) => {
    return left + colWidths.map(w => '─'.repeat((w ?? 0) + 2)).join(middle) + right;
  };

  const topLine = horizontalLine('┌', '┬', '┐');
  const midLine = horizontalLine('├', '┼', '┤');
  const bottomLine = horizontalLine('└', '┴', '┘');

  // Header row
  const headerRow = '│ ' + headers.map((h, i) => bold(h.padEnd(colWidths[i] ?? 0))).join(' │ ') + ' │';

  let table = topLine + '\n';
  table += headerRow + '\n';
  table += midLine + '\n';

  // Data rows
  data.forEach(item => {
    const row = '│ ' + headers.map((header, i) => {
      const value = String((item as any)[header] ?? '');
      return value.padEnd(colWidths[i] ?? 0);
    }).join(' │ ') + ' │';
    table += row + '\n';
  });

  table += bottomLine;

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
 * Delete file if it exists
 *
 * @param filePath - Path to file
 */
export function deleteFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      printInfo('File deleted', { path: filePath });
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
 * Print a section header
 *
 * @param title - Section title
 */
export function printSection(title: string): void {
  console.log('\n' + cyan(bold(`━━━ ${title} ━━━`)) + '\n');
}

/**
 * Print key-value pairs in a formatted way
 *
 * @param data - Object with key-value pairs
 */
export function printKeyValue(data: Record<string, unknown>): void {
  const maxKeyLength = Math.max(...Object.keys(data).map(k => k.length));

  Object.entries(data).forEach(([key, value]) => {
    const paddedKey = key.padEnd(maxKeyLength);
    const formattedValue = typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
    console.log(`  ${dim(paddedKey)} ${cyan('│')} ${formattedValue}`);
  });
}

/**
 * Print a divider line
 */
export function printDivider(): void {
  console.log(dim('─'.repeat(process.stdout.columns || 80)));
}