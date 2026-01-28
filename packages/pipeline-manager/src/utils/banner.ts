import figlet from 'figlet';
import pico from 'picocolors';
import {
  APP_DESCRIPTION,
  APP_NAME,
  APP_VERSION,
  BANNER_OPTIONS,
  STATUS_COLORS,
  generateExecutionId,
} from '../config/cli.constants';

const { bold, green, cyan, dim, magenta, yellow, red } = pico;

/**
 * Banner display options
 */
export interface BannerOptions {
  /**
   * Show application description
   * @default true
   */
  showDescription?: boolean;

  /**
   * Display minimal banner without ASCII art
   * @default false
   */
  minimal?: boolean;

  /**
   * Custom message to display
   */
  message?: string;

  /**
   * Show timestamp
   * @default false
   */
  showTimestamp?: boolean;

  /**
   * Show execution ID
   * @default false
   */
  showExecutionId?: boolean;
}

/**
 * Box styling options
 */
export interface BoxOptions {
  /**
   * Box color
   * @default 'cyan'
   */
  color?: 'green' | 'cyan' | 'magenta' | 'yellow' | 'red';

  /**
   * Padding inside box
   * @default 0
   */
  padding?: number;

  /**
   * Fixed width of box
   */
  width?: number;

  /**
   * Box style
   * @default 'single'
   */
  style?: 'single' | 'double' | 'rounded' | 'bold';
}

/**
 * Progress indicator options
 */
export interface ProgressOptions {
  /**
   * Show percentage
   * @default true
   */
  showPercentage?: boolean;

  /**
   * Show bar
   * @default false
   */
  showBar?: boolean;

  /**
   * Bar width
   * @default 20
   */
  barWidth?: number;

  /**
   * Color for progress
   * @default 'cyan'
   */
  color?: keyof typeof STATUS_COLORS;
}

/**
 * Box border styles
 */
const BOX_STYLES = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bold: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
} as const;

/**
 * Display CLI banner with application info
 *
 * @param options - Banner display options
 *
 * @example
 * ```typescript
 * banner();
 * // Displays full banner with ASCII art
 *
 * banner({ minimal: true });
 * // Displays compact version
 *
 * banner({ message: 'Welcome!' });
 * // Displays banner with custom message
 *
 * banner({ showExecutionId: true });
 * // Displays banner with execution ID
 * ```
 */
export function banner(options: BannerOptions = {}): void {
  const {
    showDescription = true,
    minimal = false,
    message,
    showTimestamp = false,
    showExecutionId = false,
  } = options;

  // Minimal banner (no ASCII art)
  if (minimal) {
    console.log(
      green(bold(`[${APP_NAME.toUpperCase()}]`)),
      cyan(`v${APP_VERSION}`),
    );

    if (message) {
      console.log(dim(message));
    }

    if (showExecutionId) {
      const executionId = generateExecutionId();
      console.log(dim(`Execution ID: ${executionId}`));
    }

    console.log('');
    return;
  }

  // Full banner with ASCII art
  try {
    const asciiArt = figlet.textSync('Pipeline Manager', BANNER_OPTIONS);
    console.log(green(asciiArt));
  } catch (error) {
    // Fallback if figlet fails
    const width = BANNER_OPTIONS.getWidth();
    console.log(green(bold('═'.repeat(width))));
    console.log(green(bold(`  ${APP_NAME.toUpperCase()}`)));
    console.log(green(bold('═'.repeat(width))));
  }

  // Display version
  console.log(
    green(bold(`[${APP_NAME.toUpperCase()}]`)),
    cyan(`v${APP_VERSION}`),
  );

  // Display custom message or description
  if (message) {
    console.log(dim(message));
  } else if (showDescription) {
    console.log(dim(APP_DESCRIPTION));
  }

  // Display execution ID if requested
  if (showExecutionId) {
    const executionId = generateExecutionId();
    console.log(dim(`Execution ID: ${executionId}`));
  }

  // Display timestamp if requested
  if (showTimestamp) {
    console.log(dim(`Started: ${new Date().toLocaleString()}`));
  }

  console.log('');
}

/**
 * Display a minimal banner (name and version only)
 *
 * @example
 * ```typescript
 * miniBanner();
 * // Output: [PIPELINE-MANAGER] v1.0.0
 * ```
 */
export function miniBanner(): void {
  console.log(
    green(bold(`[${APP_NAME.toUpperCase()}]`)),
    cyan(`v${APP_VERSION}`),
  );
  console.log('');
}

/**
 * Display banner with custom message
 *
 * @param message - Custom message to display
 *
 * @example
 * ```typescript
 * bannerWithMessage('Deployment started...');
 * ```
 */
export function bannerWithMessage(message: string): void {
  banner({ message, showDescription: false });
}

/**
 * Display a simple divider line
 *
 * @param char - Character to use for divider (default: '─')
 * @param length - Length of divider (default: terminal width or 80)
 *
 * @example
 * ```typescript
 * divider();
 * // Output: ──────────────────────────────────────────────────
 *
 * divider('═', 30);
 * // Output: ══════════════════════════════
 *
 * divider('─'); // Auto width
 * // Output: ────────────────────────────────────────── (full terminal width)
 * ```
 */
export function divider(char: string = '─', length?: number): void {
  const effectiveLength = length || process.stdout.columns || 80;
  console.log(dim(char.repeat(effectiveLength)));
}

/**
 * Display a section header
 *
 * @param title - Section title
 * @param subtitle - Optional subtitle
 *
 * @example
 * ```typescript
 * sectionHeader('Configuration', 'Loading settings...');
 * // Output:
 * // ━━━ Configuration ━━━
 * // Loading settings...
 * ```
 */
export function sectionHeader(title: string, subtitle?: string): void {
  console.log('\n' + cyan(bold(`━━━ ${title} ━━━`)));
  if (subtitle) {
    console.log(dim(subtitle));
  }
  console.log('');
}

/**
 * Display startup information
 *
 * @param info - Startup information to display
 *
 * @example
 * ```typescript
 * startupInfo({
 *   version: '1.0.0',
 *   node: 'v18.17.0',
 *   platform: 'linux',
 *   environment: 'production',
 * });
 * ```
 */
export function startupInfo(info: Record<string, string>): void {
  console.log(dim('Startup Information:'));
  Object.entries(info).forEach(([key, value]) => {
    console.log(dim(`  ${key.padEnd(15)}: ${value}`));
  });
  console.log('');
}

/**
 * Display a box around text
 *
 * @param text - Text to display in box
 * @param options - Box styling options
 *
 * @example
 * ```typescript
 * box('Important Message', { color: 'green', padding: 1 });
 * // Output:
 * // ┌─────────────────────┐
 * // │                     │
 * // │  Important Message  │
 * // │                     │
 * // └─────────────────────┘
 *
 * box('Error!', { color: 'red', style: 'double' });
 * // Output with double border
 * ```
 */
export function box(text: string, options: BoxOptions = {}): void {
  const {
    color = 'cyan',
    padding = 0,
    width,
    style = 'single',
  } = options;

  const colorMap = {
    green,
    cyan,
    magenta,
    yellow,
    red,
  } as const;
  const colorFn = colorMap[color];

  const borders = BOX_STYLES[style];
  const lines = text.split('\n');
  const maxLineLength = Math.max(...lines.map(l => l.length));
  const boxWidth: number = width || maxLineLength + (padding * 2) + 4;

  const paddingStr = ' '.repeat(padding);
  const emptyLine = borders.v + ' '.repeat(boxWidth - 2) + borders.v;

  // Top border
  console.log(colorFn(borders.tl + borders.h.repeat(boxWidth - 2) + borders.tr));

  // Top padding
  for (let i = 0; i < padding; i++) {
    console.log(colorFn(emptyLine));
  }

  // Content lines
  lines.forEach(line => {
    const textLine =
      borders.v +
      paddingStr +
      line.padEnd(boxWidth - padding * 2 - 2) +
      paddingStr +
      borders.v;
    console.log(colorFn(textLine));
  });

  // Bottom padding
  for (let i = 0; i < padding; i++) {
    console.log(colorFn(emptyLine));
  }

  // Bottom border
  console.log(colorFn(borders.bl + borders.h.repeat(boxWidth - 2) + borders.br));
  console.log('');
}

/**
 * Display a progress indicator
 *
 * @param message - Progress message
 * @param step - Current step number
 * @param total - Total number of steps
 * @param options - Progress display options
 *
 * @example
 * ```typescript
 * progress('Installing dependencies', 1, 3);
 * // Output: [1/3] Installing dependencies... (33%)
 *
 * progress('Uploading', 5, 10, { showBar: true, barWidth: 20 });
 * // Output: [5/10] Uploading... [██████████          ] 50%
 * ```
 */
export function progress(
  message: string,
  step: number,
  total: number,
  options: ProgressOptions = {},
): void {
  const {
    showPercentage = true,
    showBar = false,
    barWidth = 20,
    color = 'info',
  } = options;

  const percentage = Math.round((step / total) * 100);
  const colorMap = {
    success: green,
    error: red,
    warning: yellow,
    info: cyan,
    cyan: cyan, // Alias for info
    debug: magenta,
  } as const;
  const colorFn = colorMap[color];

  let output = `${colorFn(`[${step}/${total}]`)} ${message}...`;

  if (showBar) {
    const filled = Math.round((step / total) * barWidth);
    const empty = barWidth - filled;
    const bar = colorFn('█'.repeat(filled)) + dim('░'.repeat(empty));
    output += ` [${bar}]`;
  }

  if (showPercentage) {
    output += ` ${dim(`(${percentage}%)`)}`;
  }

  console.log(output);
}

/**
 * Display a spinner with message (static - for single update)
 *
 * @param message - Message to display
 * @param symbol - Spinner symbol
 *
 * @example
 * ```typescript
 * spinner('Loading...');
 * // Output: ⠋ Loading...
 * ```
 */
export function spinner(message: string, symbol: string = '⠋'): void {
  console.log(cyan(symbol), message);
}

/**
 * Display a status indicator
 *
 * @param status - Status type
 * @param message - Status message
 *
 * @example
 * ```typescript
 * status('success', 'Operation completed');
 * // Output: ✓ Operation completed
 *
 * status('error', 'Failed to connect');
 * // Output: ✗ Failed to connect
 * ```
 */
export function status(
  status: 'success' | 'error' | 'warning' | 'info',
  message: string,
): void {
  const icons = {
    success: green('✓'),
    error: red('✗'),
    warning: yellow('⚠'),
    info: cyan('ℹ'),
  };

  console.log(icons[status], message);
}

/**
 * Clear the console
 *
 * @example
 * ```typescript
 * clear();
 * ```
 */
export function clear(): void {
  console.clear();
}

/**
 * Display welcome message with banner
 *
 * @param username - Optional username to greet
 *
 * @example
 * ```typescript
 * welcome('John');
 * // Displays banner with "Welcome, John!"
 *
 * welcome();
 * // Displays banner with "Welcome!"
 * ```
 */
export function welcome(username?: string): void {
  const message = username ? `Welcome, ${username}!` : 'Welcome!';

  banner({
    message,
    showDescription: true,
    showTimestamp: true,
    showExecutionId: true,
  });
}

/**
 * Display goodbye message
 *
 * @param message - Optional custom goodbye message
 *
 * @example
 * ```typescript
 * goodbye();
 * // Output: Goodbye!
 *
 * goodbye('Thanks for using Pipeline Manager!');
 * // Output: Thanks for using Pipeline Manager!
 * ```
 */
export function goodbye(message: string = 'Goodbye!'): void {
  const width = process.stdout.columns || 80;
  console.log('');
  console.log(green(bold('━'.repeat(width))));
  console.log(green(bold(`  ${message}`)));
  console.log(green(bold('━'.repeat(width))));
  console.log('');
}

/**
 * Display a title card (large box with title)
 *
 * @param title - Title text
 * @param subtitle - Optional subtitle
 *
 * @example
 * ```typescript
 * titleCard('Deployment', 'Starting production deployment...');
 * ```
 */
export function titleCard(title: string, subtitle?: string): void {
  const width = Math.min(process.stdout.columns || 80, 80);
  const borders = BOX_STYLES.double;

  console.log('');
  console.log(cyan(borders.tl + borders.h.repeat(width - 2) + borders.tr));
  console.log(cyan(borders.v + ' '.repeat(width - 2) + borders.v));

  // Center title
  const titlePadding = Math.floor((width - title.length - 2) / 2);
  console.log(
    cyan(borders.v) +
      ' '.repeat(titlePadding) +
      bold(title) +
      ' '.repeat(width - title.length - titlePadding - 2) +
      cyan(borders.v),
  );

  if (subtitle) {
    const subtitlePadding = Math.floor((width - subtitle.length - 2) / 2);
    console.log(cyan(borders.v + ' '.repeat(width - 2) + borders.v));
    console.log(
      cyan(borders.v) +
        ' '.repeat(subtitlePadding) +
        dim(subtitle) +
        ' '.repeat(width - subtitle.length - subtitlePadding - 2) +
        cyan(borders.v),
    );
  }

  console.log(cyan(borders.v + ' '.repeat(width - 2) + borders.v));
  console.log(cyan(borders.bl + borders.h.repeat(width - 2) + borders.br));
  console.log('');
}

/**
 * Display a list of items with bullet points
 *
 * @param items - List items to display
 * @param options - List display options
 *
 * @example
 * ```typescript
 * list(['Item 1', 'Item 2', 'Item 3'], { bullet: '•', color: 'cyan' });
 * // Output:
 * // • Item 1
 * // • Item 2
 * // • Item 3
 * ```
 */
export function list(
  items: string[],
  options: {
    bullet?: string;
    color?: 'green' | 'cyan' | 'magenta' | 'yellow';
    indent?: number;
  } = {},
): void {
  const { bullet = '•', color = 'cyan', indent = 0 } = options;

  const colorMap = { green, cyan, magenta, yellow } as const;
  const colorFn = colorMap[color];
  const indentStr = ' '.repeat(indent);

  items.forEach(item => {
    console.log(indentStr + colorFn(bullet) + ' ' + item);
  });
}

/**
 * Display a table header separator
 *
 * @param title - Optional title for header
 *
 * @example
 * ```typescript
 * tableHeader('Results');
 * // Output: ═══════════════════════════════════════════════════════════════
 * //         Results
 * //         ═══════════════════════════════════════════════════════════════
 * ```
 */
export function tableHeader(title?: string): void {
  const width = process.stdout.columns || 80;
  console.log(cyan('═'.repeat(width)));
  if (title) {
    console.log(cyan(bold(title)));
    console.log(cyan('═'.repeat(width)));
  }
}

/**
 * Display elapsed time
 *
 * @param startTime - Start timestamp
 * @param label - Optional label
 *
 * @example
 * ```typescript
 * const start = Date.now();
 * // ... do work ...
 * elapsed(start, 'Operation');
 * // Output: Operation completed in 1.23s
 * ```
 */
export function elapsed(startTime: number, label?: string): void {
  const duration = Date.now() - startTime;
  const seconds = (duration / 1000).toFixed(2);

  const message = label
    ? `${label} completed in ${seconds}s`
    : `Completed in ${seconds}s`;

  console.log(dim(message));
}