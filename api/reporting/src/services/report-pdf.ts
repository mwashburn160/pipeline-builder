// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML -> PDF, in a capped, short-lived Chromium.
 *
 * SHORT-LIVED IS THE DESIGN, not a simplification. A resident browser would be a second
 * long-running process inside a pod sized for a Node service: it accumulates renderer
 * processes, it holds its peak heap between requests, and when it wedges every later
 * download fails until someone restarts the pod. So one browser per render, killed
 * afterwards, and the cost — roughly 300ms of launch — is paid by a download a human
 * initiated and waits on. The plan's mitigation for "headless Chromium adds image size
 * and render memory" is exactly this.
 *
 * CAPPED THREE WAYS, because each cap stops a different failure:
 *  - CONCURRENCY. Chromium's peak is what sizes the pod, so N simultaneous renders is
 *    N times the pod's limit and the OOM killer takes the whole service down — not just
 *    the download. Renders queue instead; a queue that is full refuses rather than grows.
 *  - WALL CLOCK. A render that hangs holds a slot forever and the queue behind it never
 *    drains. The timeout kills the PROCESS, not just the promise: an abandoned Chromium
 *    keeps its memory, so a promise-only timeout would leak the very thing being capped.
 *  - HEAP. `--js-flags=--max-old-space-size` bounds what one renderer can claim, so a
 *    pathological document fails its own render instead of the pod.
 *
 * NETWORK DENIED. The page is loaded with `setContent` and every request is aborted, so
 * the document cannot fetch anything even if a future edit adds a URL to it. Chromium
 * here is a layout engine for markup WE generated, not a browser — that is what makes the
 * next paragraph defensible.
 *
 * `--no-sandbox`, DELIBERATELY. Chromium's sandbox needs either a SUID helper or user
 * namespaces; the pod runs as uid 1000, non-root, with all capabilities dropped and
 * `allowPrivilegeEscalation: false`, so neither is available and Chromium would refuse to
 * start. The sandbox exists to contain hostile web content, and there is none here: the
 * only input is a document this service rendered from its own database, with the network
 * off. Handing the pod `SYS_ADMIN` to run the sandbox would trade a contained risk for a
 * real one. (See [[reference-eks-automode-bottlerocket-userns]] for the same constraint
 * biting rootless buildkit, where the answer had to be different because the input there
 * IS untrusted.)
 *
 * NOT AVAILABLE IS AN HONEST REFUSAL. A dev machine and a from-source install have no
 * Chromium, and the caller must be able to say "PDF is not available here" rather than
 * hang or 500. `pdfAvailable()` answers that, cached, the same shape `emailAvailable()`
 * uses for the same reason — and it never reports success it did not verify.
 */

import { createHash } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { createLogger, emitCounter, envBool, envInt, envStr, errorMessage } from '@pipeline-builder/api-core';
import { observe } from '@pipeline-builder/api-server';

const logger = createLogger('report-pdf');

/** Why a render did not produce a PDF. Each maps to a different caller response. */
export type PdfFailure = 'unavailable' | 'busy' | 'timeout' | 'render_failed';

export interface PdfResult {
  ok: true;
  pdf: Buffer;
  /** Milliseconds of wall clock, for the caller's log line. */
  ms: number;
}
export interface PdfRefusal {
  ok: false;
  reason: PdfFailure;
  message: string;
}

/** Is PDF rendering switched on for this instance at all? */
export function pdfEnabled(): boolean {
  return envBool('REPORT_PDF_ENABLED', true);
}

/** Where the Chromium binary lives. The alpine package's path is the default. */
export function chromiumPath(): string {
  return envStr('REPORT_PDF_CHROMIUM_PATH', '/usr/bin/chromium-browser');
}

/** Hard wall-clock ceiling for one render. */
function timeoutMs(): number {
  return envInt('REPORT_PDF_TIMEOUT_MS', 20_000, { min: 1000 });
}

/** How many renders may run at once. */
function maxConcurrent(): number {
  return envInt('REPORT_PDF_CONCURRENCY', 1, { min: 1 });
}

/** How many may WAIT. Beyond this the answer is "busy", not a longer queue. */
function maxQueued(): number {
  return envInt('REPORT_PDF_QUEUE', 4, { min: 0 });
}

/**
 * How long a queued render may wait for a slot, SEPARATELY from the render budget.
 *
 * Two budgets rather than one, because sharing them is both slow and racy. Slow: a request
 * that waits a full render budget and then renders takes twice it, while the human who
 * clicked has long since decided the feature is broken. Racy: if the wait and the render
 * expire together, whether a queued request gets admitted or refused depends on which
 * timer fires first — so the same load produces "busy" or "timeout" at random, and the
 * metric that is supposed to tell those apart tells you nothing.
 */
function queueWaitMs(): number {
  return envInt('REPORT_PDF_QUEUE_WAIT_MS', 5_000, { min: 0 });
}

/** Cap on one renderer's old-space heap, in MB. */
function heapMb(): number {
  return envInt('REPORT_PDF_HEAP_MB', 256, { min: 64 });
}

/**
 * A writable scratch directory.
 *
 * Chromium needs one and the container's root filesystem is read-only, so the deploys
 * mount an emptyDir here. Getting this wrong does not degrade — Chromium exits at
 * startup — which is why it is a named env var rather than a guess at `/tmp`.
 */
function scratchDir(): string {
  return envStr('REPORT_PDF_SCRATCH_DIR', '/tmp/report-pdf');
}

/** The launch flags, in one place so the deploy notes and the code cannot disagree. */
export function chromiumArgs(): string[] {
  return [
    // See the file header: the sandbox has nothing to contain here, and the pod cannot
    // give it the privileges it would need.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Use /tmp instead of /dev/shm. Without it Chromium wants a large shared-memory
    // segment, and a container's default /dev/shm is 64MB — which is what turns a
    // perfectly good render into an unexplained crash under any real page size. This is
    // also what keeps the four deploy targets from each needing a shm volume.
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--headless=new',
    // Nothing on this page is animated or timed, and a throttled background renderer is a
    // render that waits for a frame that never comes.
    '--disable-background-timer-throttling',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${scratchDir()}`,
    `--js-flags=--max-old-space-size=${heapMb()}`,
  ];
}

/** Availability, cached — the executable check is a syscall per render otherwise. */
let availability: { ok: boolean; at: number } | null = null;
const AVAILABILITY_TTL_MS = 60_000;

/** Clear the cached probe (tests, and a config change). */
export function resetPdfAvailability(): void {
  availability = null;
}

/**
 * Can this instance render a PDF?
 *
 * Checks the switch and then that the binary is actually EXECUTABLE — not merely present.
 * A path that exists but cannot be run is the failure mode of a bad mount or a stripped
 * image, and it would otherwise surface as a 500 on a manager's download.
 */
export async function pdfAvailable(): Promise<boolean> {
  if (!pdfEnabled()) return false;
  const now = Date.now();
  if (availability && now - availability.at < AVAILABILITY_TTL_MS) return availability.ok;
  let ok = false;
  try {
    await access(chromiumPath(), constants.X_OK);
    ok = true;
  } catch {
    // Debug, not warn: on a laptop this is the normal state and a warning per minute in
    // every developer's log trains people to ignore the logger.
    logger.debug('No executable Chromium; PDF rendering is unavailable', { path: chromiumPath() });
  }
  availability = { ok, at: now };
  return ok;
}

/**
 * The browser launcher, as a seam.
 *
 * Injectable so the queue, the timeout, the abort wiring and every refusal path are
 * covered by tests that run in milliseconds and need no 150MB binary. The default resolves
 * `puppeteer-core` LAZILY: importing it at module load would pull its dependency tree into
 * every reporting process, including the ones that never render a PDF.
 */
export interface PdfPage {
  setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  setOfflineMode?(offline: boolean): Promise<void>;
  setRequestInterception?(on: boolean): Promise<void>;
  on?(event: string, handler: (req: { abort(): void; continue(): void }) => void): void;
  emulateMediaType(type: string): Promise<void>;
  pdf(options: Record<string, unknown>): Promise<Uint8Array>;
}
export interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
  process?(): { kill(signal?: string): void } | null;
}
export type PdfLauncher = (options: { executablePath: string; args: string[] }) => Promise<PdfBrowser>;

let launcher: PdfLauncher | null = null;

/** Swap the launcher (tests). Passing null restores the real one. */
export function setPdfLauncher(next: PdfLauncher | null): void {
  launcher = next;
}

async function defaultLauncher(options: { executablePath: string; args: string[] }): Promise<PdfBrowser> {
  const mod = await import('puppeteer-core');
  const puppeteer = (mod as { default?: unknown }).default ?? mod;
  const launch = (puppeteer as { launch: (o: unknown) => Promise<unknown> }).launch;
  const browser = await launch({
    executablePath: options.executablePath,
    args: options.args,
    // The bundled Chrome is never downloaded (that is the point of `-core`), so an
    // explicit path is mandatory and a wrong one must fail loudly rather than fall back.
    headless: true,
  });
  return browser as PdfBrowser;
}

/** In-flight and waiting counts for the concurrency cap. */
let active = 0;
let queued = 0;

/** Current queue depth, for the health endpoint and tests. */
export function pdfQueueDepth(): { active: number; queued: number } {
  return { active, queued };
}

/**
 * Wait for a render slot.
 *
 * A plain counter plus polling, rather than a semaphore library: the queue is at most a
 * handful deep by construction, and the poll interval only ever costs a queued request
 * that is already waiting on a browser launch.
 */
async function acquire(): Promise<boolean> {
  if (active < maxConcurrent()) { active += 1; return true; }
  if (queued >= maxQueued()) return false;
  queued += 1;
  try {
    const deadline = Date.now() + queueWaitMs();
    while (Date.now() < deadline) {
      if (active < maxConcurrent()) { active += 1; return true; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  } finally {
    queued -= 1;
  }
}

function release(): void {
  active = Math.max(0, active - 1);
}

/**
 * Kill a browser and mean it.
 *
 * `close()` asks politely and can hang on exactly the wedged browser a timeout just fired
 * for, so the process gets SIGKILL when the close does not land promptly. A leaked
 * Chromium holds the memory this whole module exists to bound.
 */
async function destroy(browser: PdfBrowser): Promise<void> {
  const closed = browser.close().then(() => true, () => false);
  // The timer is CLEARED on the fast path. Left dangling it would hold the event loop open
  // for two seconds after every single render — harmless in production, and enough to stop
  // a test process exiting, which is how this was found.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); });
  try {
    if (await Promise.race([closed, timedOut])) return;
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    browser.process?.()?.kill('SIGKILL');
  } catch (err) {
    logger.warn('Could not kill a Chromium that would not close', { error: errorMessage(err) });
  }
}

/**
 * Render `html` to a tagged PDF.
 *
 * `tagged: true` is what makes the output accessible: it emits the structure tree, so the
 * headings and the table's row/column associations survive into the file and a screen
 * reader can navigate it. Without it a PDF of a table is a bag of positioned glyphs, and
 * every accessibility property the HTML carefully carries is discarded at the last step.
 */
export async function renderPdf(html: string): Promise<PdfResult | PdfRefusal> {
  if (!await pdfAvailable()) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'PDF rendering is not available on this instance. The report can be read in the product.',
    };
  }
  if (!await acquire()) {
    emitCounter('report_pdf_failed_total', { reason: 'busy' });
    return { ok: false, reason: 'busy', message: 'Too many reports are being rendered. Try again in a moment.' };
  }

  const started = Date.now();
  let browser: PdfBrowser | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const budget = timeoutMs();
    // One deadline for the WHOLE render — launch, layout and print together. Per-step
    // timeouts let three "fast enough" steps add up to a request nobody is still waiting on.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('render timed out')), budget);
    });

    const work = (async (): Promise<Buffer> => {
      browser = await (launcher ?? defaultLauncher)({ executablePath: chromiumPath(), args: chromiumArgs() });
      const page = await browser.newPage();
      // Belt and braces on the network: offline mode, plus aborting anything that still
      // tries. Either alone would do; both mean a future edit to the HTML cannot quietly
      // re-enable fetching by working around one of them.
      await page.setOfflineMode?.(true);
      if (page.setRequestInterception && page.on) {
        await page.setRequestInterception(true);
        page.on('request', (req) => { try { req.abort(); } catch { /* already handled */ } });
      }
      await page.setContent(html, { waitUntil: 'load', timeout: budget });
      // `print`, so the document's own @page margins and page-break rules apply. Screen
      // media would paginate by accident and split tables mid-row.
      await page.emulateMediaType('print');
      const out = await page.pdf({
        format: 'A4',
        printBackground: true,
        tagged: true,
        // Margins live in the document's `@page`; setting them here as well would apply
        // both and silently double them.
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        preferCSSPageSize: true,
        timeout: budget,
      });
      return Buffer.from(out);
    })();

    const pdf = await Promise.race([work, deadline]);
    const ms = Date.now() - started;
    emitCounter('report_pdf_rendered_total');
    // A histogram, not just a count: the number that matters is the tail. A p50 of 800ms
    // with a p99 of 19s says the timeout is about to start firing, and a mean would hide it.
    observe('report_pdf_render_duration_seconds', {}, ms / 1000);
    // A short digest, not the file: enough to tell "the manager and I are looking at the
    // same document" apart from "they have an older copy", without logging the report.
    logger.info('Rendered a report PDF', {
      ms, bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex').slice(0, 12),
    });
    return { ok: true, pdf, ms };
  } catch (err) {
    const message = errorMessage(err);
    const reason: PdfFailure = /timed out|timeout/i.test(message) ? 'timeout' : 'render_failed';
    emitCounter('report_pdf_failed_total', { reason });
    // The HTML is NOT logged. It carries the org's delivery numbers and a lead's notes,
    // and a render failure is not a reason to copy a report into the operational log.
    logger.warn('Report PDF render failed', { reason, ms: Date.now() - started, error: message });
    return {
      ok: false,
      reason,
      message: reason === 'timeout'
        ? 'The report took too long to render. Try again, or read it in the product.'
        : 'The report could not be rendered as a PDF.',
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (browser) await destroy(browser);
    release();
  }
}
