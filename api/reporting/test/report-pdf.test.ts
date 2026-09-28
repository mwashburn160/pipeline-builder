// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PDF worker: its caps, its refusals, and the properties that keep a browser inside a
 * Node service pod from being a liability.
 *
 * NO REAL CHROMIUM. The launcher is a seam precisely so these run in milliseconds and in
 * CI without a 150MB binary — and because what can actually go wrong is the CONTROL
 * around the browser, not the browser. Chromium renders HTML correctly; what breaks is a
 * render that hangs holding the only slot, a timeout that resolves the promise and leaves
 * the process alive, a queue that grows instead of refusing, or a missing binary
 * surfacing as a 500 on a manager's download.
 *
 * WHAT IS PINNED, and why each one is a bug that has a real shape:
 *
 *  - A LEAKED BROWSER IS THE FAILURE THIS MODULE EXISTS TO PREVENT. Every exit path —
 *    success, render error, timeout — must close the browser, and a close that hangs must
 *    escalate to SIGKILL. A promise-only timeout would "recover" while the Chromium it
 *    abandoned keeps every megabyte.
 *  - THE SLOT IS ALWAYS RELEASED. One throwing render that forgot to decrement the counter
 *    wedges every later download until the pod restarts, and it looks like "PDFs randomly
 *    stopped working" rather than like a leak.
 *  - THE PAGE GETS NO NETWORK. Offline mode AND request interception, so a future edit to
 *    the HTML cannot turn the renderer into a fetcher.
 *  - `tagged: true`. Without it the accessible structure the HTML carefully carries is
 *    thrown away at the last step, and every a11y property of the feature is cosmetic.
 *  - AN ABSENT BINARY IS A NAMED REFUSAL, not an exception. A laptop has no Chromium and
 *    must say so.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const ENV_KEYS = [
  'REPORT_PDF_ENABLED', 'REPORT_PDF_CHROMIUM_PATH', 'REPORT_PDF_TIMEOUT_MS',
  'REPORT_PDF_CONCURRENCY', 'REPORT_PDF_QUEUE', 'REPORT_PDF_QUEUE_WAIT_MS', 'REPORT_PDF_HEAP_MB',
  'REPORT_PDF_SCRATCH_DIR',
] as const;
const saved: Record<string, string | undefined> = {};

// `process.execPath` is a binary that certainly exists and is certainly executable, which
// is what `pdfAvailable()` checks. Using it means the availability probe is exercised for
// real rather than mocked away — the probe is the thing that decides whether a manager
// gets a PDF or a 503, so a test that stubbed it would pin nothing.
const REAL_EXECUTABLE = process.execPath;

const {
  renderPdf, pdfAvailable, pdfEnabled, chromiumPath, chromiumArgs,
  resetPdfAvailability, setPdfLauncher, pdfQueueDepth,
} = await import('../src/services/report-pdf.js');

type FakePage = {
  setContent: AnyFn;
  setOfflineMode: AnyFn;
  setRequestInterception: AnyFn;
  on: AnyFn;
  emulateMediaType: AnyFn;
  pdf: AnyFn;
};

interface FakeBrowser {
  page: FakePage;
  closed: number;
  killed: string[];
  newPage: AnyFn;
  close: AnyFn;
  process: AnyFn;
}

/** A browser whose behaviour each test bends: the page can stall, throw, or succeed. */
function fakeBrowser(over: {
  pdfImpl?: () => Promise<Uint8Array>;
  closeImpl?: () => Promise<void>;
  omitInterception?: boolean;
} = {}): FakeBrowser {
  const killed: string[] = [];
  const page: FakePage = {
    setContent: jest.fn<AnyFn>(async () => undefined),
    setOfflineMode: jest.fn<AnyFn>(async () => undefined),
    setRequestInterception: jest.fn<AnyFn>(async () => undefined),
    on: jest.fn<AnyFn>(),
    emulateMediaType: jest.fn<AnyFn>(async () => undefined),
    pdf: jest.fn<AnyFn>(over.pdfImpl ?? (async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]))),
  };
  if (over.omitInterception) {
    delete (page as Partial<FakePage>).setRequestInterception;
    delete (page as Partial<FakePage>).on;
  }
  const browser: FakeBrowser = {
    page,
    closed: 0,
    killed,
    newPage: jest.fn<AnyFn>(async () => page),
    close: jest.fn<AnyFn>(async () => {
      browser.closed += 1;
      if (over.closeImpl) await over.closeImpl();
    }),
    process: jest.fn<AnyFn>(() => ({ kill: (sig?: string) => killed.push(sig ?? 'SIGTERM') })),
  };
  return browser;
}

/** Install a launcher that hands back `browser` and records its options. */
function useBrowser(browser: FakeBrowser): { options: Array<{ executablePath: string; args: string[] }> } {
  const options: Array<{ executablePath: string; args: string[] }> = [];
  setPdfLauncher(async (o) => { options.push(o); return browser as never; });
  return { options };
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.REPORT_PDF_CHROMIUM_PATH = REAL_EXECUTABLE;
  delete process.env.REPORT_PDF_ENABLED;
  resetPdfAvailability();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setPdfLauncher(null);
  resetPdfAvailability();
});

describe('availability', () => {
  it('is on by default, so a correctly built image needs no configuration', () => {
    expect(pdfEnabled()).toBe(true);
  });

  it('defaults to the alpine package path the Dockerfile installs', () => {
    delete process.env.REPORT_PDF_CHROMIUM_PATH;
    expect(chromiumPath()).toBe('/usr/bin/chromium-browser');
  });

  it('reports unavailable when the binary is missing — a laptop, or a from-source install', async () => {
    process.env.REPORT_PDF_CHROMIUM_PATH = '/nonexistent/chromium';
    expect(await pdfAvailable()).toBe(false);
  });

  it('reports unavailable when the switch is off, without touching the filesystem', async () => {
    process.env.REPORT_PDF_ENABLED = 'false';
    expect(await pdfAvailable()).toBe(false);
  });

  it('reports available for a real executable', async () => {
    expect(await pdfAvailable()).toBe(true);
  });

  it('caches the probe, so a download does not cost a syscall per render', async () => {
    expect(await pdfAvailable()).toBe(true);
    // Moving the path without clearing the cache must NOT change the answer — that is what
    // proves the second call did not re-probe.
    process.env.REPORT_PDF_CHROMIUM_PATH = '/nonexistent/chromium';
    expect(await pdfAvailable()).toBe(true);
    resetPdfAvailability();
    expect(await pdfAvailable()).toBe(false);
  });

  it('refuses with a reason a caller can turn into a 503, not an exception', async () => {
    process.env.REPORT_PDF_CHROMIUM_PATH = '/nonexistent/chromium';
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unavailable');
    // The message is read by a manager, so it says what they can do instead.
    expect(result.message).toMatch(/read in the product/i);
  });
});

describe('the launch flags', () => {
  const args = () => chromiumArgs();

  it('disables the sandbox, because the pod cannot grant what it would need', () => {
    // Justified at length in the module header: uid 1000, no capabilities, no user
    // namespaces — and the only input is HTML this service generated, with no network.
    expect(args()).toContain('--no-sandbox');
  });

  it('keeps Chromium off /dev/shm, whose container default is 64MB', () => {
    // Without this a render crashes unexplained under any real page size, and every deploy
    // target would need its own shared-memory volume.
    expect(args()).toContain('--disable-dev-shm-usage');
  });

  it('points the user-data dir at the writable scratch mount, not the read-only root', () => {
    process.env.REPORT_PDF_SCRATCH_DIR = '/tmp/pdf-scratch';
    expect(args()).toContain('--user-data-dir=/tmp/pdf-scratch');
  });

  it('caps the renderer heap, so one pathological document fails itself and not the pod', () => {
    process.env.REPORT_PDF_HEAP_MB = '128';
    expect(args()).toContain('--js-flags=--max-old-space-size=128');
  });
});

describe('a successful render', () => {
  it('returns the bytes and passes the executable path and flags through', async () => {
    const browser = fakeBrowser();
    const { options } = useBrowser(browser);
    const result = await renderPdf('<html><body>hi</body></html>');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(options[0]?.executablePath).toBe(REAL_EXECUTABLE);
    expect(options[0]?.args).toContain('--no-sandbox');
  });

  it('asks for a TAGGED pdf — without it every accessibility property is discarded', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    const opts = (browser.page.pdf as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.tagged).toBe(true);
  });

  it('prints with the document\'s own page size and zero engine margins', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    const opts = (browser.page.pdf as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    // The HTML owns its @page margins. Setting them here as well applies both and silently
    // doubles them.
    expect(opts.preferCSSPageSize).toBe(true);
    expect(opts.margin).toEqual({ top: '0', right: '0', bottom: '0', left: '0' });
  });

  it('emulates PRINT media, so @page breaks apply and tables do not split mid-row', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    expect(browser.page.emulateMediaType).toHaveBeenCalledWith('print');
  });

  it('sets the content directly rather than navigating to a URL', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html><body>x</body></html>');
    expect(browser.page.setContent).toHaveBeenCalled();
    expect((browser.page.setContent as jest.Mock).mock.calls[0]?.[0]).toContain('<body>x</body>');
  });

  it('closes the browser afterwards and frees the slot', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    expect(browser.closed).toBe(1);
    expect(pdfQueueDepth()).toEqual({ active: 0, queued: 0 });
  });
});

describe('the page gets no network', () => {
  it('switches the page offline', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    expect(browser.page.setOfflineMode).toHaveBeenCalledWith(true);
  });

  it('aborts every request the document still tries to make', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    expect(browser.page.setRequestInterception).toHaveBeenCalledWith(true);
    const handler = (browser.page.on as jest.Mock).mock.calls
      .find((c) => c[0] === 'request')?.[1] as (r: { abort(): void; continue(): void }) => void;
    expect(handler).toBeDefined();
    const abort = jest.fn<AnyFn>();
    const cont = jest.fn<AnyFn>();
    handler({ abort, continue: cont });
    expect(abort).toHaveBeenCalled();
    expect(cont).not.toHaveBeenCalled();
  });

  it('survives an abort that throws, rather than failing the whole render', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    const handler = (browser.page.on as jest.Mock).mock.calls
      .find((c) => c[0] === 'request')?.[1] as (r: { abort(): void; continue(): void }) => void;
    // Puppeteer throws if the request was already handled. A render must not die for it.
    expect(() => handler({ abort: () => { throw new Error('already handled'); }, continue: () => undefined }))
      .not.toThrow();
  });

  it('still renders when the page object has no interception API at all', async () => {
    // Offline mode alone is enough; the two overlap deliberately. A page shape without
    // interception must not crash the render.
    const browser = fakeBrowser({ omitInterception: true });
    useBrowser(browser);
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(true);
  });
});

describe('failures', () => {
  it('reports render_failed and frees the slot when the page throws', async () => {
    const browser = fakeBrowser({ pdfImpl: async () => { throw new Error('layout exploded'); } });
    useBrowser(browser);
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('render_failed');
    // The slot is the thing: leaking it wedges every later download.
    expect(pdfQueueDepth().active).toBe(0);
    expect(browser.closed).toBe(1);
  });

  it('reports a launch failure rather than propagating it', async () => {
    setPdfLauncher(async () => { throw new Error('spawn ENOENT'); });
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('render_failed');
    expect(pdfQueueDepth().active).toBe(0);
  });

  it('times out a hanging render, and KILLS the browser rather than abandoning it', async () => {
    process.env.REPORT_PDF_TIMEOUT_MS = '1000';
    // A close that never resolves is the wedged-browser case the SIGKILL exists for.
    const browser = fakeBrowser({
      pdfImpl: () => new Promise<Uint8Array>(() => undefined),
      closeImpl: () => new Promise<void>(() => undefined),
    });
    useBrowser(browser);
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
    expect(result.message).toMatch(/too long/i);
    // The escalation is the point: a timeout that only rejected the promise would leave
    // this Chromium holding its memory forever.
    expect(browser.killed).toContain('SIGKILL');
    expect(pdfQueueDepth().active).toBe(0);
  }, 15_000);

  it('does not kill a browser that closed cleanly', async () => {
    const browser = fakeBrowser();
    useBrowser(browser);
    await renderPdf('<html></html>');
    expect(browser.killed).toEqual([]);
  });

  it('logs rather than throwing when even the kill fails', async () => {
    process.env.REPORT_PDF_TIMEOUT_MS = '1000';
    const browser = fakeBrowser({
      pdfImpl: () => new Promise<Uint8Array>(() => undefined),
      closeImpl: () => new Promise<void>(() => undefined),
    });
    // A process that has already exited throws ESRCH. There is nothing left to do about it,
    // and a throw here would replace a clean "timeout" refusal with an unhandled rejection
    // in the cleanup path.
    browser.process = jest.fn<AnyFn>(() => ({ kill: () => { throw new Error('ESRCH'); } }));
    useBrowser(browser);
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout');
    expect(pdfQueueDepth().active).toBe(0);
  }, 15_000);

  it('tolerates a browser with no process handle to kill', async () => {
    process.env.REPORT_PDF_TIMEOUT_MS = '1000';
    const browser = fakeBrowser({
      pdfImpl: () => new Promise<Uint8Array>(() => undefined),
      closeImpl: () => new Promise<void>(() => undefined),
    });
    browser.process = jest.fn<AnyFn>(() => null);
    useBrowser(browser);
    const result = await renderPdf('<html></html>');
    expect(result.ok).toBe(false);
    expect(pdfQueueDepth().active).toBe(0);
  }, 15_000);
});

describe('the concurrency cap', () => {
  it('refuses with "busy" once the queue is full, instead of letting it grow', async () => {
    process.env.REPORT_PDF_CONCURRENCY = '1';
    process.env.REPORT_PDF_QUEUE = '0';
    process.env.REPORT_PDF_TIMEOUT_MS = '2000';
    // A HOLDER rather than a bare `let`: TypeScript narrows a `let` assigned only inside a
    // callback to `never` at the later read, so releasing it later fails to typecheck even
    // though it is correct at runtime. A property is not narrowed that way.
    const gate: { release: (() => void) | null } = { release: null };
    const browser = fakeBrowser({
      pdfImpl: () => new Promise<Uint8Array>((resolve) => {
        gate.release = () => resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      }),
    });
    useBrowser(browser);

    const first = renderPdf('<html>1</html>');
    // Let the first render take the only slot before the second asks for one.
    await new Promise((r) => setTimeout(r, 20));
    const second = await renderPdf('<html>2</html>');

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toBe('busy');
    // A queue depth of zero means "refuse", and a refusal a human retries beats a request
    // that waits behind twenty others and then times out anyway.
    expect(second.message).toMatch(/try again/i);

    gate.release?.();
    await first;
    expect(pdfQueueDepth()).toEqual({ active: 0, queued: 0 });
  }, 15_000);

  it('lets a second render wait when the queue has room, and serves it', async () => {
    process.env.REPORT_PDF_CONCURRENCY = '1';
    process.env.REPORT_PDF_QUEUE = '2';
    process.env.REPORT_PDF_QUEUE_WAIT_MS = '5000';
    process.env.REPORT_PDF_TIMEOUT_MS = '5000';
    // A HOLDER rather than a bare `let`: TypeScript narrows a `let` assigned only inside a
    // callback to `never` at the later read, so releasing it later fails to typecheck even
    // though it is correct at runtime. A property is not narrowed that way.
    const gate: { release: (() => void) | null } = { release: null };
    let calls = 0;
    const browser = fakeBrowser({
      pdfImpl: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Uint8Array>((resolve) => {
            gate.release = () => resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
          });
        }
        return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      },
    });
    useBrowser(browser);

    const first = renderPdf('<html>1</html>');
    await new Promise((r) => setTimeout(r, 20));
    const second = renderPdf('<html>2</html>');
    await new Promise((r) => setTimeout(r, 20));
    expect(pdfQueueDepth().queued).toBe(1);

    gate.release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(pdfQueueDepth()).toEqual({ active: 0, queued: 0 });
  }, 20_000);

  it('gives up waiting rather than queueing forever', async () => {
    process.env.REPORT_PDF_CONCURRENCY = '1';
    process.env.REPORT_PDF_QUEUE = '2';
    // The WAIT budget is short while the RENDER budget stays long, which is the whole
    // reason they are separate settings: sharing one made this outcome a coin flip between
    // "busy" and "timeout" depending on which timer fired first.
    process.env.REPORT_PDF_QUEUE_WAIT_MS = '200';
    process.env.REPORT_PDF_TIMEOUT_MS = '10000';
    // A HOLDER rather than a bare `let`: TypeScript narrows a `let` assigned only inside a
    // callback to `never` at the later read, so releasing it later fails to typecheck even
    // though it is correct at runtime. A property is not narrowed that way.
    const gate: { release: (() => void) | null } = { release: null };
    const browser = fakeBrowser({
      pdfImpl: () => new Promise<Uint8Array>((resolve) => {
        gate.release = () => resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      }),
    });
    useBrowser(browser);

    const first = renderPdf('<html>1</html>');
    await new Promise((r) => setTimeout(r, 20));
    const second = await renderPdf('<html>2</html>');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    // Waiting past the render budget is pointless: nobody is still holding the connection.
    expect(second.reason).toBe('busy');

    gate.release?.();
    await first;
  }, 15_000);
});
