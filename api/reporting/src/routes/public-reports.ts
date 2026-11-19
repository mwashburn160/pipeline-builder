// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The UNAUTHENTICATED half of stakeholder reports, under `/public/*`.
 *
 * Four routes, all authorized by a token rather than a session, because the people they
 * exist for have no account: the manager reading a shared report, the same manager saving
 * it as a PDF, the recipient confirming their own address, and the recipient who has had
 * enough of it.
 *
 * WHY A PUBLIC ROUTE AT ALL. The audience for these reports is managers and
 * stakeholders who will not be provisioned into the platform to read a weekly
 * summary. A mailed attachment would be a copy nobody can withdraw and nobody can
 * supersede; a link is a report the org can still revoke, and the PDF behind it is
 * rendered from the same token on demand rather than pushed into an inbox.
 *
 * WHAT MAKES IT SAFE ENOUGH:
 *
 *  - The token is 256 bits of CSPRNG output, stored only as a SHA-256 hash, and
 *    resolvable to exactly one run. A database copy cannot be turned back into
 *    working URLs.
 *  - It EXPIRES (30 days by default, 180 at most) and is revocable, so a link
 *    pasted into a Slack channel three jobs ago is not a permanent door.
 *  - Sharing is OFF unless an org admin turned it on, so an org that never
 *    considered public links has none.
 *  - The response is a frozen snapshot: numbers and labels. There is no query
 *    parameter to widen, no pipeline to trigger, no id to enumerate.
 *  - `noindex` + `no-referrer` + `Cache-Control: private` keep the URL out of
 *    search engines, out of the next site's referrer header, and out of shared
 *    caches — the three ordinary ways a secret URL stops being secret.
 *  - Redaction, when the link was minted with it, replaces project and pipeline
 *    names and hides error text: internal names leak intent
 *    (`project-atlas-migration`) even when the numbers are harmless, and a raw
 *    error message leaks hostnames and paths. Stage and action names and the
 *    numbers stay.
 *  - Rate-limited per client IP, so the token space cannot be probed.
 *
 * VIEW COUNTS EXCLUDE BOTS. A link pasted into Slack is fetched by Slack; a link
 * mailed through Microsoft 365 is fetched by Safe Links. Counting those tells the
 * lead their manager read the report when nobody has, so the unfurlers and
 * scanners are recognised and served without being counted.
 */

import { createHash } from 'node:crypto';
import { ANONYMOUS_ACTOR_ID, audited, createLogger, emitCounter, ErrorCode, recordAudit, sendError, sendSuccess, validateBody } from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { renderReportHtml, reportFileName, stakeholderReportStore } from '@pipeline-builder/pipeline-data';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { sendPdf, sendPdfRefusal } from '../helpers/report-helpers.js';
import { pdfAvailable, renderPdf } from '../services/report-pdf.js';

const logger = createLogger('public-reports');

/**
 * User-agent fragments belonging to link unfurlers, preview generators and mail
 * security scanners. Matched case-insensitively against the whole UA.
 *
 * This list decides VIEW COUNTS ONLY. Nothing is refused for being on it and
 * nothing is admitted for being off it, so a miss costs an inflated count, never
 * access — which is why a substring list is the right tool here and would be the
 * wrong one for authorization.
 */
const BOT_AGENTS = [
  'slackbot', 'slack-imgproxy',
  'discordbot', 'telegrambot', 'whatsapp', 'twitterbot', 'facebookexternalhit',
  'linkedinbot', 'skypeuripreview', 'bingpreview', 'googlebot', 'applebot',
  // Microsoft 365 / Defender for Office "Safe Links" detonation, and the Office
  // clients that pre-fetch a URL to render a card.
  'safelinks', 'microsoftpreview', 'ms-office', 'msoffice', 'outlook',
  'proofpoint', 'mimecast', 'barracuda', 'symantec', 'urldefense',
  'bot', 'crawler', 'spider', 'preview', 'scanner', 'monitor', 'curl', 'wget',
];

/** Is this request a machine fetching a preview rather than a person reading? */
export function isPreviewFetch(req: Request): boolean {
  // A HEAD is never a read: it cannot render anything.
  if (req.method === 'HEAD') return true;
  const ua = (req.headers['user-agent'] ?? '').toString().toLowerCase();
  if (!ua) return true; // no UA at all is a script, not a browser
  if (BOT_AGENTS.some((frag) => ua.includes(frag))) return true;
  // Browser prefetch/prerender hints: the person has not opened it yet.
  const purpose = `${req.headers.purpose ?? ''} ${req.headers['x-purpose'] ?? ''} ${req.headers['sec-purpose'] ?? ''}`.toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('preview') || purpose.includes('prerender');
}

/** What a redacted share link shows in place of an error message. */
export const REDACTED_ERROR_TEXT = 'Error (redacted)';

/**
 * Keys whose value is free-form ERROR TEXT, in every spelling a section answers.
 *
 * An error message is the one place a snapshot carries text nobody wrote for a reader:
 * `errors[].error_pattern` is the first 200 characters of the raw message, and
 * `build_failures[].error_message` is the whole thing. Those carry hostnames, repository
 * paths, package names and pipeline names that the name keys never see, so a redacted
 * link hides them outright rather than trying to pseudonymize inside a sentence.
 *
 * An explicit list rather than a pattern, so a classification that merely mentions
 * failure (`failure_pct`, `failures`, `lastFailureStage`) is untouched. Both camel and
 * snake case, because raw-SQL sections answer snake_case.
 */
export const ERROR_TEXT_KEYS: ReadonlySet<string> = new Set([
  'error', 'errorMessage', 'error_message', 'errorPattern', 'error_pattern',
  'errorText', 'error_text', 'errorDetail', 'error_detail',
  'failureMessage', 'failure_message', 'failureReason', 'failure_reason',
  // `detail.failure` on an execution row: an object or string straight from the event.
  'failure',
]);

/**
 * Which pseudonym each NAME key gets, by kind — so a placeholder says what it stands
 * for. Pipeline and project names read "Pipeline N" (the reader's unit is a pipeline);
 * the organization reads "Organization N".
 *
 * DELIBERATELY ABSENT:
 *  - the generic `name`. No section's pipeline rows carry it; the rows that do are
 *    plugins (`plugin_versions`), and plugin and environment names (`nodejs-build`,
 *    `production`) are product vocabulary, not internal project names. Pseudonymizing
 *    them as "Pipeline N" mislabelled them as pipelines.
 *  - opaque ids (`id`, `orgId`). A UUID names nothing, and the snapshot joins rows on it.
 *
 * The snake_case spellings too: some sections are raw SQL rows (stage_bottlenecks
 * answers `pipeline_name`), not camelCase-mapped ones.
 */
const NAME_KINDS: Readonly<Record<string, string>> = Object.freeze({
  pipeline: 'Pipeline',
  pipelineName: 'Pipeline',
  pipeline_name: 'Pipeline',
  pipelineId: 'Pipeline',
  pipeline_id: 'Pipeline',
  project: 'Pipeline',
  projectName: 'Pipeline',
  project_name: 'Pipeline',
  organization: 'Organization',
  organizationName: 'Organization',
  organization_name: 'Organization',
  orgName: 'Organization',
  org_name: 'Organization',
  repository: 'Repository',
  repo: 'Repository',
  branch: 'Branch',
});

/**
 * Redact a snapshot for a share link minted with `redactNames`.
 *
 * TWO THINGS GO:
 *  - Internal NAMES ({@link NAME_KINDS}) become a stable placeholder of their kind
 *    ("Pipeline 2", "Organization 1"), so a chart still has the same number of series
 *    and the reader can still tell them apart. One name gets the same placeholder
 *    everywhere in the snapshot.
 *  - ERROR TEXT ({@link ERROR_TEXT_KEYS}) becomes {@link REDACTED_ERROR_TEXT}, whatever
 *    its type, in every section and at any depth.
 *
 * WHAT STAYS: structure, numbers (counts, occurrences, rates, durations), stage and
 * action names, environment and plugin names, opaque ids, and non-text classification
 * such as the failure category. A null error stays null, so "no error" never reads as
 * a hidden one.
 */
export function redactNames(value: unknown, seen = new Map<string, string>()): unknown {
  const counts = new Map<string, number>();
  const placeholder = (kind: string, original: string): string => {
    const key = `${kind}\u0000${original}`;
    const existing = seen.get(key);
    if (existing) return existing;
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    const label = `${kind} ${n}`;
    seen.set(key, label);
    return label;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      const kind = Object.hasOwn(NAME_KINDS, key) ? NAME_KINDS[key] : undefined;
      if (ERROR_TEXT_KEYS.has(key) && val !== null && val !== undefined) out[key] = REDACTED_ERROR_TEXT;
      else if (kind && typeof val === 'string' && val.length > 0) out[key] = placeholder(kind, val);
      else out[key] = walk(val);
    }
    return out;
  };
  return walk(value);
}

/** Headers every public report response carries, success or failure. */
function publicHeaders(res: Response): void {
  // Out of search engines, and out of AI/LLM crawler indexes that follow the same
  // directive. A shared report URL in a search result is the failure mode here.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  // The URL IS the credential, so it must not travel in a referrer header to
  // whatever the reader clicks next.
  res.setHeader('Referrer-Policy', 'no-referrer');
  // `private` keeps it out of shared caches; `no-store` keeps it off disk on a
  // shared machine. A stakeholder report is one person's copy, not a CDN asset.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Nothing here is meant to be framed into another site.
  res.setHeader('X-Frame-Options', 'DENY');
}

const verifyBody = z.object({
  token: z.string().min(16).max(256),
}).strict();

/** A token path segment: base64url, bounded. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export function createPublicReportRoutes(): Router {
  const router = Router();

  router.use(((_req: Request, res: Response, next: NextFunction) => {
    publicHeaders(res);
    next();
  }) as RequestHandler);

  // Per client IP (the trusted one, resolved by `trust proxy` — never a raw
  // forwarding header), so the token space cannot be probed and one reader
  // refreshing cannot cost anything.
  const reads = rateLimitByOrg({
    name: 'public-report-read',
    keyBy: 'ip',
    max: 60,
    windowMs: 60_000,
    message: 'Too many requests. Wait a minute and reload.',
  }) as RequestHandler;
  // A PDF costs a browser launch where a page view costs a row read, so it gets its own,
  // much tighter bucket. Sharing the read limiter would turn one link into 60 Chromium
  // launches a minute.
  const pdfReads = rateLimitByOrg({
    name: 'public-report-pdf',
    keyBy: 'ip',
    max: 6,
    windowMs: 60_000,
    message: 'Too many PDF downloads. Wait a minute and try again.',
  }) as RequestHandler;
  const writes = rateLimitByOrg({
    name: 'public-report-verify',
    keyBy: 'ip',
    max: 10,
    windowMs: 60_000,
    message: 'Too many attempts. Wait a minute and try again.',
  }) as RequestHandler;

  /**
   * `GET /public/reports/:token` — the shared report.
   *
   * ONE indistinguishable 404 for every failure: unknown token, revoked link,
   * expired link, unpublished or deleted run. Someone holding a dead link learns
   * that it does not work and nothing else — not that it once did, not that the
   * org exists, not that the report was withdrawn.
   */
  router.get('/reports/:token', reads, withRoute(async ({ req, res, ctx }) => {
    const token = String(req.params.token ?? '');
    if (!TOKEN.test(token)) return notFound(res);

    const resolved = await stakeholderReportStore.resolveShareLink(token);
    if (!resolved) {
      // Logged without the token: an access log that carries working credentials is
      // a credential store.
      ctx.log('COMPLETED', 'Public report link not served', { reason: 'unresolved' });
      return notFound(res);
    }
    const { link, run } = resolved;

    const preview = isPreviewFetch(req);
    if (!preview) {
      // Best-effort: a counter write must never cost the reader their report.
      await stakeholderReportStore.recordShareView(link).catch(() => undefined);
      // LAUNCH METRIC: link views. Fleet-wide and BOT-EXCLUDED for the same reason the
      // per-link count is — a Slack unfurl is not somebody reading the report, and an
      // adoption number that counts unfurls says the feature is working when it is not.
      emitCounter('report_link_viewed_total', { redacted: String(link.redactNames) });
    }

    // EVERY access is logged, counted or not — this is the org's record of who
    // reached a shared report, and "a bot fetched it" is part of that record.
    logger.info('Shared report accessed', {
      linkId: link.id,
      runId: run.id,
      orgId: link.orgId,
      counted: !preview,
      userAgent: (req.headers['user-agent'] ?? '').toString().slice(0, 200),
      ip: req.ip,
    });

    const snapshot = link.redactNames ? redactNames(run.snapshot) : run.snapshot;
    return sendSuccess(res, 200, {
      report: {
        periodLabel: run.periodLabel,
        periodStart: run.periodStart.toISOString(),
        periodEnd: run.periodEnd.toISOString(),
        version: run.version,
        publishedAt: run.publishedAt?.toISOString() ?? null,
        leadNotes: run.leadNotes,
        snapshot,
        namesRedacted: link.redactNames,
      },
      // Generic on purpose: a link preview card in a chat channel must not spill
      // the org, the team or the numbers to everyone in the channel. The person who
      // opens it sees the report; the card says only that there is one.
      preview: {
        title: 'Engineering delivery report',
        description: 'A published delivery report. Sign-in is not required; the link expires.',
      },
      expiresAt: link.expiresAt.toISOString(),
    });
  }, { requireOrgId: false }));

  /**
   * `GET /public/reports/:token/pdf` — the same shared report, as a file.
   *
   * THE PDF CARRIES NOTHING THE PAGE DOES NOT. It is rendered from the same redacted
   * snapshot, through the same token, with the same indistinguishable 404 — so a manager
   * who saves the file has exactly what they could already read, and a token that stops
   * working stops working for both. The rule is worth naming because the obvious shortcut
   * (render from the run row, since we have it) would quietly hand out the executive
   * summary and the unredacted names that the page deliberately withholds.
   *
   * ITS OWN, TIGHTER RATE LIMIT. A render costs a Chromium launch, where a page view costs
   * a row read; sharing the read limiter would let one link turn 60 requests a minute into
   * 60 browser launches.
   */
  router.get('/reports/:token/pdf', pdfReads, withRoute(async ({ req, res, ctx }) => {
    const token = String(req.params.token ?? '');
    if (!TOKEN.test(token)) return notFound(res);

    const resolved = await stakeholderReportStore.resolveShareLink(token);
    if (!resolved) {
      ctx.log('COMPLETED', 'Public report PDF not served', { reason: 'unresolved' });
      return notFound(res);
    }
    const { link, run } = resolved;

    // Availability is checked BEFORE the render and answered as 503: an instance with no
    // Chromium is misconfigured or simply a from-source install, and telling the reader
    // "not available here, read it in the product" is the honest answer. A 404 would say
    // the link is dead, which it is not.
    if (!await pdfAvailable()) {
      return sendError(res, 503, 'PDF download is not available on this instance.', ErrorCode.SERVICE_UNAVAILABLE);
    }

    // Counted like a page view, and excluded for the same bots — somebody saving the PDF
    // has read the report, and a scanner fetching it has not.
    const preview = isPreviewFetch(req);
    if (!preview) {
      await stakeholderReportStore.recordShareView(link).catch(() => undefined);
      emitCounter('report_pdf_downloaded_total', { source: 'share_link' });
    }
    logger.info('Shared report PDF accessed', {
      linkId: link.id, runId: run.id, orgId: link.orgId, counted: !preview,
    });

    const snapshot = link.redactNames ? redactNames(run.snapshot) : run.snapshot;
    const html = renderReportHtml({
      title: 'Delivery report',
      periodLabel: run.periodLabel,
      periodStart: run.periodStart.toISOString(),
      periodEnd: run.periodEnd.toISOString(),
      version: run.version,
      publishedAt: run.publishedAt?.toISOString() ?? null,
      leadNotes: run.leadNotes,
      // Deliberately absent: the shared VIEW does not show the AI summary, so the shared
      // FILE must not either.
      snapshot: snapshot as Parameters<typeof renderReportHtml>[0]['snapshot'],
      namesRedacted: link.redactNames,
      expiresAt: link.expiresAt.toISOString(),
      renderedAt: new Date().toISOString(),
    });

    const result = await renderPdf(html);
    if (!result.ok) return sendPdfRefusal(res, result);
    ctx.log('COMPLETED', 'Served shared report PDF', { runId: run.id, ms: result.ms, bytes: result.pdf.length });
    sendPdf(res, result.pdf, reportFileName('delivery-report', run.periodLabel, run.version));
  }, { requireOrgId: false }));

  /**
   * `POST /public/report-recipients/verify` — confirm a delivery address.
   *
   * POST, not GET, and that is deliberate: a mail scanner or a preview fetch
   * following a GET would consume the confirmation before the person ever clicked
   * it, and they would then be told the link was already used. The emailed link
   * opens a page; the page posts the token.
   *
   * The token is consumed on success, so a forwarded confirmation cannot be
   * replayed by whoever it was forwarded to.
   */
  router.post('/report-recipients/verify', writes, audited('reporting.report.recipient.verified'), withRoute(async ({ req, res, ctx }) => {
    const validation = validateBody(req, verifyBody);
    if (!validation.ok) return sendError(res, 400, 'A confirmation token is required', ErrorCode.VALIDATION_ERROR);
    const recipient = await stakeholderReportStore.verifyRecipientByToken(validation.value.token);
    if (!recipient) {
      // Same answer for expired, already-used and never-existed: the person's next
      // action is identical (ask the sender to resend), and distinguishing them
      // would turn this into an address oracle.
      ctx.log('COMPLETED', 'Recipient verification not accepted');
      return sendError(
        res, 400,
        'This confirmation link is no longer valid. Ask the sender to send a new one.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    ctx.log('COMPLETED', 'Recipient verified', { recipientId: recipient.id });
    // Audited despite being unauthenticated, because it is the moment an address
    // becomes DELIVERABLE — org data can reach it from the next send. Bounded by
    // construction: the token is single-use and consumed here, so a caller cannot
    // write a second row with it (a failed attempt writes none).
    recordAudit({
      action: 'reporting.report.recipient.verified',
      actorId: ANONYMOUS_ACTOR_ID,
      orgId: recipient.orgId,
      targetType: 'report-recipient',
      targetId: recipient.id,
      details: { recipientHash: recipientHash(recipient.email) },
    });
    return sendSuccess(res, 200, { verified: true, email: recipient.email });
  }, { requireOrgId: false }));

  /**
   * `POST /public/report-recipients/unsubscribe` — stop emailing this address.
   *
   * POST, and the URL in the `List-Unsubscribe` header, for one specific reason: mail
   * security scanners and corporate link-prefetchers follow GETs. An unsubscribe on GET
   * would quietly remove managers from the distribution list the moment their employer's
   * mail gateway inspected the message, and nobody would find out until somebody asked
   * why the reports stopped. RFC 8058's one-click unsubscribe is a POST, so the mail
   * client's own button works against this route directly, and a person who follows the
   * link in a browser lands on a page that posts it for them.
   *
   * IDEMPOTENT, and reports success for an unknown token as well as a known one. There is
   * nothing useful to distinguish: someone who clicks twice, or forwards the mail to a
   * colleague who clicks it, wants the same outcome both times, and an error page here
   * would read as "we are still going to email you". Answering the same way for a token
   * that never existed also keeps this from being an oracle for guessing tokens.
   */
  router.post('/report-recipients/unsubscribe', writes, audited('reporting.report.recipient.unsubscribed'), withRoute(async ({ req, res, ctx }) => {
    // The token rides the QUERY STRING, because RFC 8058 fixes the one-click body to
    // `List-Unsubscribe=One-Click` — the mail client has nowhere to put a token. The body
    // is accepted too, for the browser page that posts it on a person's behalf.
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
    const fromBody = (req.body as { token?: unknown } | undefined)?.token;
    const token = fromQuery ?? (typeof fromBody === 'string' ? fromBody : undefined);
    if (!token || !TOKEN.test(token)) {
      return sendError(res, 400, 'An unsubscribe token is required', ErrorCode.VALIDATION_ERROR);
    }
    const result = await stakeholderReportStore.unsubscribeByToken(token);
    ctx.log('COMPLETED', 'Unsubscribe processed', { matched: result.matched });
    // Only the click that actually stopped delivery is recorded: a repeat click or
    // an unknown token changes nothing and writes nothing, so an
    // externally-triggered route cannot append unbounded rows to an org's trail.
    if (result.recipient && result.newlyUnsubscribed) {
      recordAudit({
        action: 'reporting.report.recipient.unsubscribed',
        actorId: ANONYMOUS_ACTOR_ID,
        orgId: result.recipient.orgId,
        targetType: 'report-recipient',
        targetId: result.recipient.id,
        details: { recipientHash: recipientHash(result.recipient.email) },
      });
    }
    return sendSuccess(res, 200, { unsubscribed: true });
  }, { requireOrgId: false }));

  return router;
}

/**
 * A recipient address as the audit row carries it: a truncated SHA-256 of the
 * normalized address. These rows are written by an UNAUTHENTICATED caller and
 * read far more widely than the recipient list, so the address itself stays on
 * the recipient row; the hash still lets a reviewer match a row to an address
 * they already know.
 */
function recipientHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function notFound(res: Response): void {
  sendError(res, 404, 'This report link is not available. It may have expired or been revoked.', ErrorCode.NOT_FOUND);
}
