// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The UNAUTHENTICATED half of stakeholder reports, under `/public/*`.
 *
 * Three routes, all authorized by a token rather than a session, because the people they
 * exist for have no account: the manager reading a shared report, the recipient
 * confirming their own address, and the recipient who has had enough of it.
 *
 * WHY A PUBLIC ROUTE AT ALL. The audience for these reports is managers and
 * stakeholders who will not be provisioned into the platform to read a weekly
 * summary. Without a link they get a PDF attachment and the numbers stop being
 * live; with one they read the frozen snapshot the lead published.
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
 *  - Name redaction, when the link was minted with it, replaces project and
 *    pipeline names: internal names leak intent (`project-atlas-migration`) even
 *    when the numbers are harmless.
 *  - Rate-limited per client IP, so the token space cannot be probed.
 *
 * VIEW COUNTS EXCLUDE BOTS. A link pasted into Slack is fetched by Slack; a link
 * mailed through Microsoft 365 is fetched by Safe Links. Counting those tells the
 * lead their manager read the report when nobody has, so the unfurlers and
 * scanners are recognised and served without being counted.
 */

import { createLogger, emitCounter, ErrorCode, sendError, sendSuccess, validateBody } from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { stakeholderReportStore } from '@pipeline-builder/pipeline-data';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

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

/**
 * Redact internal names from a snapshot. Structure, labels and numbers survive;
 * anything that looks like a project, pipeline or repository identifier is
 * replaced by a stable placeholder, so a chart still has the same number of
 * series and the reader can still tell them apart.
 */
export function redactNames(value: unknown, seen = new Map<string, string>()): unknown {
  const NAME_KEYS = new Set(['project', 'projectName', 'pipeline', 'pipelineName', 'pipelineId', 'repository', 'repo', 'branch', 'name']);
  const placeholder = (original: string): string => {
    const existing = seen.get(original);
    if (existing) return existing;
    const label = `Pipeline ${seen.size + 1}`;
    seen.set(original, label);
    return label;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = NAME_KEYS.has(key) && typeof val === 'string' && val.length > 0 ? placeholder(val) : walk(val);
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
  router.post('/report-recipients/verify', writes, withRoute(async ({ req, res, ctx }) => {
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
  router.post('/report-recipients/unsubscribe', writes, withRoute(async ({ req, res, ctx }) => {
    // The token rides the QUERY STRING, because RFC 8058 fixes the one-click body to
    // `List-Unsubscribe=One-Click` — the mail client has nowhere to put a token. The body
    // is accepted too, for the browser page that posts it on a person's behalf.
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
    const fromBody = (req.body as { token?: unknown } | undefined)?.token;
    const token = fromQuery ?? (typeof fromBody === 'string' ? fromBody : undefined);
    if (!token || !TOKEN.test(token)) {
      return sendError(res, 400, 'An unsubscribe token is required', ErrorCode.VALIDATION_ERROR);
    }
    const honoured = await stakeholderReportStore.unsubscribeByToken(token);
    ctx.log('COMPLETED', 'Unsubscribe processed', { matched: honoured });
    return sendSuccess(res, 200, { unsubscribed: true });
  }, { requireOrgId: false }));

  return router;
}

function notFound(res: Response): void {
  sendError(res, 404, 'This report link is not available. It may have expired or been revoked.', ErrorCode.NOT_FOUND);
}
