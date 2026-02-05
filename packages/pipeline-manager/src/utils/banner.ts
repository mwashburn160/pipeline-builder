import figlet from 'figlet';
import pico from 'picocolors';
import {
  APP_DESCRIPTION,
  APP_NAME,
  APP_VERSION,
  BANNER_OPTIONS,
  generateExecutionId,
} from '../config/cli.constants';

const { bold, green, cyan, dim } = pico;

/**
 * Banner display options
 */
export interface BannerOptions {
  showDescription?: boolean;
  minimal?: boolean;
  message?: string;
  showTimestamp?: boolean;
  showExecutionId?: boolean;
}

/**
 * Display CLI banner with application info
 */
export function banner(options: BannerOptions = {}): void {
  const {
    showDescription = true,
    minimal = false,
    message,
    showTimestamp = false,
    showExecutionId = false,
  } = options;

  if (minimal) {
    console.log(
      green(bold(`[${APP_NAME.toUpperCase()}]`)),
      cyan(`v${APP_VERSION}`),
    );
    if (message) console.log(dim(message));
    if (showExecutionId) console.log(dim(`Execution ID: ${generateExecutionId()}`));
    console.log('');
    return;
  }

  // Full banner with ASCII art
  try {
    const asciiArt = figlet.textSync('Pipeline Manager', BANNER_OPTIONS);
    console.log(green(asciiArt));
  } catch {
    const width = BANNER_OPTIONS.getWidth();
    console.log(green(bold('═'.repeat(width))));
    console.log(green(bold(`  ${APP_NAME.toUpperCase()}`)));
    console.log(green(bold('═'.repeat(width))));
  }

  console.log(
    green(bold(`[${APP_NAME.toUpperCase()}]`)),
    cyan(`v${APP_VERSION}`),
  );

  if (message) {
    console.log(dim(message));
  } else if (showDescription) {
    console.log(dim(APP_DESCRIPTION));
  }

  if (showExecutionId) console.log(dim(`Execution ID: ${generateExecutionId()}`));
  if (showTimestamp) console.log(dim(`Started: ${new Date().toLocaleString()}`));

  console.log('');
}

/**
 * Display a minimal banner (name and version only)
 */
export function miniBanner(): void {
  console.log(
    green(bold(`[${APP_NAME.toUpperCase()}]`)),
    cyan(`v${APP_VERSION}`),
  );
  console.log('');
}
