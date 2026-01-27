import figlet from 'figlet';
import pico from 'picocolors';
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, BANNER_OPTIONS } from '../config/cli-constants';

const { bold, green, cyan, dim, magenta } = pico;

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
 * ```
 */
export function banner(options: {
  showDescription?: boolean;
  minimal?: boolean;
  message?: string;
  showTimestamp?: boolean;
} = {}): void {
  const {
    showDescription = true,
    minimal = false,
    message,
    showTimestamp = false,
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

    console.log('');
    return;
  }

  // Full banner with ASCII art
  try {
    console.log(
      green(figlet.textSync('Pipeline Manager', BANNER_OPTIONS)),
    );
  } catch (error) {
    // Fallback if figlet fails
    console.log(green(bold('═'.repeat(50))));
    console.log(green(bold(`  ${APP_NAME.toUpperCase()}`)));
    console.log(green(bold('═'.repeat(50))));
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
 * @param length - Length of divider (default: 50)
 *
 * @example
 * ```typescript
 * divider();
 * // Output: ──────────────────────────────────────────────────
 *
 * divider('═', 30);
 * // Output: ══════════════════════════════
 * ```
 */
export function divider(char: string = '─', length: number = 50): void {
  console.log(dim(char.repeat(length)));
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
 * });
 * ```
 */
export function startupInfo(info: Record<string, string>): void {
  console.log(dim('Startup Information:'));
  Object.entries(info).forEach(([key, value]) => {
    console.log(dim(`  ${key}: ${value}`));
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
 * ```
 */
export function box(
  text: string,
  options: {
    color?: 'green' | 'cyan' | 'magenta' | 'yellow';
    padding?: number;
    width?: number;
  } = {},
): void {
  const { color = 'cyan', padding = 0, width } = options;

  const colorFn = {
    green,
    cyan,
    magenta,
    yellow: pico.yellow,
  }[color];

  const textLength = text.length;
  const boxWidth = width || textLength + (padding * 2) + 4;
  const paddingStr = ' '.repeat(padding);
  const emptyLine = '│' + ' '.repeat(boxWidth - 2) + '│';
  const textLine = '│' + paddingStr + text.padEnd(boxWidth - padding * 2 - 2) + paddingStr + '│';

  console.log(colorFn('┌' + '─'.repeat(boxWidth - 2) + '┐'));

  for (let i = 0; i < padding; i++) {
    console.log(colorFn(emptyLine));
  }

  console.log(colorFn(textLine));

  for (let i = 0; i < padding; i++) {
    console.log(colorFn(emptyLine));
  }

  console.log(colorFn('└' + '─'.repeat(boxWidth - 2) + '┘'));
  console.log('');
}

/**
 * Display a progress indicator
 *
 * @param message - Progress message
 * @param step - Current step number
 * @param total - Total number of steps
 *
 * @example
 * ```typescript
 * progress('Installing dependencies', 1, 3);
 * // Output: [1/3] Installing dependencies...
 * ```
 */
export function progress(message: string, step: number, total: number): void {
  const percentage = Math.round((step / total) * 100);
  console.log(
    magenta(`[${step}/${total}]`),
    `${message}...`,
    dim(`(${percentage}%)`),
  );
}

/**
 * Clear the console
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
 * ```
 */
export function welcome(username?: string): void {
  const message = username
    ? `Welcome, ${username}!`
    : 'Welcome!';

  banner({ message, showDescription: true, showTimestamp: true });
}

/**
 * Display goodbye message
 *
 * @param message - Optional custom goodbye message
 */
export function goodbye(message: string = 'Goodbye!'): void {
  console.log('');
  console.log(green(bold('━'.repeat(50))));
  console.log(green(bold(`  ${message}`)));
  console.log(green(bold('━'.repeat(50))));
  console.log('');
}