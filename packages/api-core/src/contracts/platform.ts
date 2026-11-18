// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY platform.
 *
 *  - `/internal/notify-email` (+ `/status`) — the email relay: five body legs
 *    (tenant, report, quota notice, offer notice, ecosystem notice), told apart
 *    by the BODY ({@link notifyEmailLegOf}), each checking its own caller.
 *  - `/internal/ecosystem/*` — Verified-publisher facts and approver counts (plugin).
 *  - `/internal/offers/seat-activity/:orgId` — the offers value signal (billing).
 *  - `/internal/reporting/*` — identity facts and access posture (reporting).
 *  - `/internal/support/entitlement/:orgId` — support entitlement (message).
 *  - `/internal/ai/*` — an org's AI switch, providers and decrypted key.
 *  - `/internal/ops/*` — the identity facts ops-center needs (an org's
 *    account root for feature quotas, and the audit-activity aggregations its
 *    dashboards render over platform's Mongo audit trail).
 *
 * Request schemas carry the server's own 400 messages, so a route that
 * validates with them answers exactly as it did when it hand-parsed. Response
 * schemas carry the NORMALIZATION each client already applied (non-string list
 * entries dropped, absent optional counts defaulted) so a client that parses
 * through the contract reads exactly what it read before.
 */

import { z } from 'zod';
import { defineInternalEndpoint } from './define.js';
import { AI_KEY_PROVIDER_IDS } from '../types/ai-catalog.js';
import { parseEcosystemNotifyRequest, type EcosystemNotifyRequest } from '../types/ecosystem-notifications.js';
import { parseQueryString } from '../utils/params.js';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Organization ids are 24-hex ObjectIds. */
const ORG_ID = /^[a-f0-9]{24}$/i;
/** Platform user ids. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORG_ID_MESSAGE = 'orgId must be an organization id';

/** `:orgId`, a 24-hex ObjectId, lowercased. */
const orgIdParam = z.string({ error: ORG_ID_MESSAGE }).regex(ORG_ID, ORG_ID_MESSAGE).transform((s) => s.toLowerCase());

/** A list of strings, non-strings dropped; anything but an array reads as `[]`. */
const stringList = z.unknown().optional().transform((v): string[] => (
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
));

/** A non-negative finite count, or a parse failure. */
const count = z.number().finite().nonnegative();

/** System-org member service token; the caller is authorized by its key-bound name. */
const SERVICE_TOKEN = 'Service token (system-org member); the caller is authorized by its key-bound service name.';

// ---------------------------------------------------------------------------
// /internal/notify-email
// ---------------------------------------------------------------------------

const required = () => z.string({ message: 'is required' }).min(1, 'is required');

/** Tenant leg (`compliance`, `reporting`): email an org's users. */
export const notifyEmailSchema = z.object({
  orgId: required(),
  subject: required(),
  text: required(),
  /** Specific recipients; non-strings are dropped, absent means the org's admins. */
  targetUsers: z.unknown().optional().transform((v) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : null)),
});

/** Quota leg (`quota` only): a threshold notice to the org's admins + billing contacts. */
export const notifyQuotaEmailSchema = z.object({
  quotaNotice: z.literal(true),
  orgId: required(),
  subject: required(),
  text: required(),
});

/** Offer leg (`billing` only): an expansion offer to the same people as a quota notice. */
export const notifyOfferEmailSchema = z.object({
  offerNotice: z.literal(true),
  orgId: required(),
  subject: required(),
  text: required(),
});

/**
 * Alert leg (`ops-center` only): one org alert destination of channel
 * `email`, i.e. ONE address an org admin configured (not a member lookup).
 */
export const notifyAlertEmailSchema = z.object({
  alertEmail: z.literal(true),
  orgId: required(),
  to: z.string().min(3, 'is required').max(320),
  subject: required(),
  text: required(),
});

/** Report recipients per send — the ceiling on a compromised reporting token. */
export const REPORT_EMAIL_MAX_RECIPIENTS = 50;

/** Report leg (`reporting` only): one message per verified address. */
export const notifyReportEmailSchema = z.object({
  orgId: required(),
  subject: required(),
  text: required(),
  html: z.string().optional(),
  reportRecipients: z.array(z.object({
    email: z.string().min(3).max(320),
    unsubscribeUrl: z.string().max(2048).optional(),
  })).min(1, 'is required').max(REPORT_EMAIL_MAX_RECIPIENTS),
});

/** Which relay leg a notify-email body is for. */
export type NotifyEmailLeg = 'report' | 'quota' | 'offer' | 'alert' | 'ecosystem' | 'tenant';

/**
 * The relay leg a body is for, decided by its keys exactly as the relay
 * dispatches: `reportRecipients`, then `quotaNotice`, then `offerNotice`, then
 * `alertEmail`, then an ecosystem notice's `recipients` RULES; anything else is
 * the tenant leg.
 */
export function notifyEmailLegOf(raw: unknown): NotifyEmailLeg {
  if (raw && typeof raw === 'object') {
    if ('reportRecipients' in raw) return 'report';
    if ('quotaNotice' in raw) return 'quota';
    if ('offerNotice' in raw) return 'offer';
    if ('alertEmail' in raw) return 'alert';
    if ('recipients' in raw) return 'ecosystem';
  }
  return 'tenant';
}

/** The parsed body of one notify-email send, whichever leg. */
export type NotifyEmailBody =
  | z.output<typeof notifyEmailSchema>
  | z.output<typeof notifyQuotaEmailSchema>
  | z.output<typeof notifyOfferEmailSchema>
  | z.output<typeof notifyReportEmailSchema>
  | z.output<typeof notifyAlertEmailSchema>
  | EcosystemNotifyRequest;

/** Any leg's body, validated by the leg its keys select (the relay's own dispatch). */
const NotifyEmailBodySchema = z.unknown().transform((raw, ctx): NotifyEmailBody => {
  const leg = notifyEmailLegOf(raw);
  if (leg === 'ecosystem') {
    const parsed = parseEcosystemNotifyRequest(raw);
    if (typeof parsed === 'string') {
      ctx.addIssue({ code: 'custom', message: parsed });
      return z.NEVER;
    }
    return parsed;
  }
  const schema = leg === 'report' ? notifyReportEmailSchema
    : leg === 'quota' ? notifyQuotaEmailSchema
      : leg === 'offer' ? notifyOfferEmailSchema
        : leg === 'alert' ? notifyAlertEmailSchema
          : notifyEmailSchema;
  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  }
  return result.data;
});

/**
 * Every leg's reply, in one shape. Each field carries the reading its clients
 * applied: a count that is not a number is absent, a list drops non-strings.
 * `failed` is a list of addresses on the report leg and a count on the
 * ecosystem leg, so it is kept as sent.
 */
const NotifyEmailResponse = z.object({
  ok: z.boolean().optional().catch(undefined),
  recipientCount: z.number().optional().catch(undefined),
  sent: z.unknown().optional().transform((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)),
  failed: z.unknown().optional(),
  inApp: z.number().optional().catch(undefined),
  emailed: z.number().optional().catch(undefined),
  suppressed: z.number().optional().catch(undefined),
});

// ---------------------------------------------------------------------------
// /internal/ecosystem/approvers query
// ---------------------------------------------------------------------------

/** The only permissions an ecosystem decision can require. */
export const ECOSYSTEM_DECISION_PERMISSIONS = ['plugins:moderate', 'publishers:verify'] as const;
const LIST_MESSAGE = 'excludeOrgIds / excludeUserIds must be comma-separated ids (at most 20)';

/**
 * A comma-separated id list: de-duplicated, normalized, at most 20, each valid.
 * Yields the normalized list RE-JOINED with commas (so the parsed query is
 * itself a valid query), `''` for none; split it with {@link splitIdList}.
 */
function idList(valid: RegExp, normalize: (s: string) => string = (s) => s) {
  return z.unknown().optional().transform((raw, ctx): string => {
    if (raw === undefined || raw === '') return '';
    if (typeof raw !== 'string') {
      ctx.addIssue({ code: 'custom', message: LIST_MESSAGE });
      return z.NEVER;
    }
    const items = [...new Set(raw.split(',').map((s) => normalize(s.trim())).filter(Boolean))];
    if (items.length > 20 || items.some((s) => !valid.test(s))) {
      ctx.addIssue({ code: 'custom', message: LIST_MESSAGE });
      return z.NEVER;
    }
    return items.join(',');
  });
}

/** A parsed `idList` value as its ids. */
export function splitIdList(joined: string): string[] {
  return joined ? joined.split(',') : [];
}

// ---------------------------------------------------------------------------
// /internal/offers/seat-activity window
// ---------------------------------------------------------------------------

/** Default seat-activity window, in days — a billing period is the unit that matters. */
const DEFAULT_WINDOW_DAYS = 30;
/** Bounded so a caller cannot ask for an unbounded scan of history. */
const MAX_WINDOW_DAYS = 365;

// ---------------------------------------------------------------------------
// /internal/reporting
// ---------------------------------------------------------------------------

/** Deliberately loose — the address is only ever compared, never delivered to. */
const EMAIL = /^[^\s@]+@[^\s@]{1,253}$/;
const EMAIL_MESSAGE = 'email must be an email address';

/** `from` / `to` ISO timestamps → a window, with the route's two messages. */
const PostureWindow = z.object({
  from: z.unknown().optional(),
  to: z.unknown().optional(),
}).transform((q, ctx): { from: Date; to: Date } => {
  const from = new Date(String(q.from ?? ''));
  const to = new Date(String(q.to ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'from and to must both be ISO timestamps' });
    return z.NEVER;
  }
  if (from.getTime() >= to.getTime()) {
    ctx.addIssue({ code: 'custom', message: 'from must be before to' });
    return z.NEVER;
  }
  return { from, to };
});

/** reporting's posture reader: a count, coerced and floored at 0. */
const postureCount = z.unknown().optional().transform((v): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
});

// ---------------------------------------------------------------------------
// /internal/support/entitlement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /internal/ai
// ---------------------------------------------------------------------------

const AI_ORG_ID = /^(?:[a-f0-9]{24}|system)$/i;
const AI_PROVIDERS = new Set(AI_KEY_PROVIDER_IDS);
const AI_AUTH = 'Service token SCOPED to the path org (`orgId` claim must equal :orgId, else 403).';

// ---------------------------------------------------------------------------
// /internal/ops (ops-center)
// ---------------------------------------------------------------------------

/** The named aggregations over platform's audit trail an ops dashboard can render. */
export const AUDIT_ACTIVITY_QUERIES = ['events_by_action', 'top_actors_24h', 'recent_events'] as const;
export type AuditActivityQuery = typeof AUDIT_ACTIVITY_QUERIES[number];
/** The range presets the observability surface understands. */
export const AUDIT_ACTIVITY_RANGES = ['1h', '6h', '24h'] as const;
export type AuditActivityRange = typeof AUDIT_ACTIVITY_RANGES[number];
/** Ceiling on `liveOrgIds` per call (the log view's tenant cap is far below it). */
export const LIVE_ORG_IDS_MAX = 1000;
/** Ceiling on `recent_events` rows per call. */
export const AUDIT_ACTIVITY_MAX_LIMIT = 500;

const auditSeries = z.object({
  labels: z.record(z.string(), z.string()),
  values: z.array(z.object({ time: z.number(), value: z.string() })),
});

/** What an audit-activity query returns: a Prometheus-shaped matrix, or a stream of rows. */
export const AuditActivityResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('matrix'), series: z.array(auditSeries), step: z.string() }),
  z.object({
    kind: z.literal('stream'),
    entries: z.array(z.object({ time: z.number(), line: z.string(), labels: z.record(z.string(), z.string()) })),
  }),
]);
export type AuditActivityResultData = z.output<typeof AuditActivityResult>;

const OPS_AUTH = 'Service token from ops-center (system-org member); the caller is authorized by its key-bound service name.';

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

export const PLATFORM_INTERNAL = {
  /**
   * The email relay. One body per leg ({@link notifyEmailLegOf}); each leg
   * refuses a caller other than its own with 403, and the tenant/report/quota/
   * offer legs are tenant-bound to the token's org.
   */
  notifyEmail: defineInternalEndpoint({
    id: 'platform.notifyEmail',
    service: 'platform',
    method: 'POST',
    path: '/internal/notify-email',
    callers: ['billing', 'compliance', 'ops-center', 'plugin', 'quota', 'reporting'],
    auth: 'Service token scoped to the org the mail is for (tenant/report/quota/offer/alert legs); system-org for an ecosystem notice (plugin only).',
    params: z.object({}),
    body: NotifyEmailBodySchema,
    response: NotifyEmailResponse,
  }),
  /** Whether this instance can send email at all (EMAIL_ENABLED). */
  notifyEmailStatus: defineInternalEndpoint({
    id: 'platform.notifyEmailStatus',
    service: 'platform',
    method: 'GET',
    path: '/internal/notify-email/status',
    callers: ['ask', 'ops-center', 'plugin', 'reporting'],
    auth: SERVICE_TOKEN,
    params: z.object({}),
    response: z.object({ enabled: z.boolean() }),
  }),
  /** The Verified-publisher application's platform-held facts about an org. */
  publisherEligibility: defineInternalEndpoint({
    id: 'platform.publisherEligibility',
    service: 'platform',
    method: 'GET',
    path: '/internal/ecosystem/publisher-eligibility/:orgId',
    callers: ['plugin'],
    auth: SERVICE_TOKEN,
    params: z.object({ orgId: orgIdParam }),
    response: z.object({
      verifiedDomains: z.array(z.unknown()).transform((v) => v.filter((x): x is string => typeof x === 'string')),
      owners: count,
      ownersWithMfa: count,
    }),
  }),
  /** How many people could decide an ecosystem request (counts, never identities). */
  ecosystemApprovers: defineInternalEndpoint({
    id: 'platform.ecosystemApprovers',
    service: 'platform',
    method: 'GET',
    path: '/internal/ecosystem/approvers',
    callers: ['plugin'],
    auth: SERVICE_TOKEN,
    params: z.object({}),
    query: z.object({
      permission: z.unknown().refine(
        (v): v is typeof ECOSYSTEM_DECISION_PERMISSIONS[number] => typeof v === 'string' && (ECOSYSTEM_DECISION_PERMISSIONS as readonly string[]).includes(v),
        `permission must be one of: ${ECOSYSTEM_DECISION_PERMISSIONS.join(', ')}`,
      ).transform((v) => v as typeof ECOSYSTEM_DECISION_PERMISSIONS[number]),
      excludeOrgIds: idList(ORG_ID, (s) => s.toLowerCase()),
      excludeUserIds: idList(USER_ID),
    }),
    response: z.object({ holders: count, eligible: count, superadmins: count }),
  }),
  /** Seats held against members who actually used them, over a window (never 400s). */
  offerSeatActivity: defineInternalEndpoint({
    id: 'platform.offerSeatActivity',
    service: 'platform',
    method: 'GET',
    path: '/internal/offers/seat-activity/:orgId',
    callers: ['billing'],
    auth: 'Service token scoped to the org (billing sends the tenant org with x-org-id).',
    params: z.object({ orgId: z.string() }),
    query: z.object({
      windowDays: z.unknown().optional().transform((v): number => {
        const requested = Number(parseQueryString(v) ?? DEFAULT_WINDOW_DAYS);
        return Number.isFinite(requested) ? Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(requested))) : DEFAULT_WINDOW_DAYS;
      }),
    }),
    response: z.object({
      seatActivity: z.object({
        orgId: z.string(),
        windowDays: z.number(),
        seatsHeld: z.number(),
        activeMembers: z.number(),
        /** Joined inside the window and not yet active in it — counted apart
         *  so a just-added member does not read as a disengaging seat. */
        newMembers: z.number(),
      }),
    }),
  }),
  /** May this user still run reports here, and what does the account hold? */
  reportAuthority: defineInternalEndpoint({
    id: 'platform.reportAuthority',
    service: 'platform',
    method: 'GET',
    path: '/internal/reporting/report-authority/:orgId/:userId',
    callers: ['reporting'],
    auth: SERVICE_TOKEN,
    params: z.object({
      orgId: orgIdParam,
      userId: z.string({ error: 'userId must be a user id' }).regex(USER_ID, 'userId must be a user id'),
    }),
    response: z.object({
      active: z.boolean(),
      permissions: stringList,
      features: stringList,
      tier: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : undefined)),
    }),
  }),
  /** Is this ONE address an active member of the org? */
  reportRecipientCheck: defineInternalEndpoint({
    id: 'platform.reportRecipientCheck',
    service: 'platform',
    method: 'GET',
    path: '/internal/reporting/recipient-check/:orgId',
    callers: ['reporting'],
    auth: SERVICE_TOKEN,
    params: z.object({ orgId: orgIdParam }),
    query: z.object({
      email: z.unknown().optional()
        .transform((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
        .pipe(z.string().regex(EMAIL, EMAIL_MESSAGE).max(320, EMAIL_MESSAGE)),
    }),
    response: z.object({
      member: z.boolean(),
      userId: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : undefined)),
      displayName: z.unknown().optional().transform((v) => (typeof v === 'string' ? v : undefined)),
    }),
  }),
  /** Access-posture COUNTS for a report window (never a row, name or id). */
  reportAccessPosture: defineInternalEndpoint({
    id: 'platform.reportAccessPosture',
    service: 'platform',
    method: 'GET',
    path: '/internal/reporting/access-posture/:orgId',
    callers: ['reporting'],
    auth: SERVICE_TOKEN,
    params: z.object({ orgId: orgIdParam }),
    query: PostureWindow,
    response: z.object({
      members: z.number(),
      membersWithMfa: postureCount,
      ssoRequired: z.unknown().optional().transform((v) => v === true),
      serviceAccounts: postureCount,
      activeApiKeys: postureCount,
      permissionChanges: postureCount,
    }),
  }),
  /** An org's support entitlement (platform's `SupportEntitlement`; `-1` = unlimited on the limits). */
  supportEntitlement: defineInternalEndpoint({
    id: 'platform.supportEntitlement',
    service: 'platform',
    method: 'GET',
    path: '/internal/support/entitlement/:orgId',
    callers: ['message'],
    auth: SERVICE_TOKEN,
    params: z.object({ orgId: orgIdParam }),
    response: z.object({
      level: z.string().nullable(),
      premium: z.boolean(),
      premiumLimit: z.number(),
      limit: z.number(),
      used: z.number(),
      ownOrgContacts: z.number(),
      canDesignate: z.boolean(),
      canOpenCase: z.boolean(),
    }),
  }),
  /** The org's AI switch and which providers it holds its OWN key for. 404 for an unknown org. */
  orgAIAccess: defineInternalEndpoint({
    id: 'platform.orgAIAccess',
    service: 'platform',
    method: 'GET',
    path: '/internal/ai/access/:orgId',
    callers: ['ask', 'pipeline', 'plugin', 'reporting'],
    auth: AI_AUTH,
    params: z.object({
      orgId: z.string({ error: ORG_ID_MESSAGE }).regex(AI_ORG_ID, ORG_ID_MESSAGE).transform((s) => s.toLowerCase()),
    }),
    response: z.object({ aiEnabled: z.boolean(), providers: stringList }),
  }),
  /**
   * The DECRYPTED org key for one provider (audited on platform, never logged).
   * 400 for a provider that is not key-based — checked AFTER the org scope (403).
   */
  orgAIKey: defineInternalEndpoint({
    id: 'platform.orgAIKey',
    service: 'platform',
    method: 'GET',
    path: '/internal/ai/keys/:orgId/:provider',
    callers: ['ask', 'pipeline', 'plugin', 'reporting'],
    auth: AI_AUTH,
    params: z.object({
      orgId: z.string({ error: ORG_ID_MESSAGE }).regex(AI_ORG_ID, ORG_ID_MESSAGE).transform((s) => s.toLowerCase()),
      provider: z.string().refine((p) => AI_PROVIDERS.has(p), 'provider must be a key-based AI provider'),
    }),
    response: z.object({ provider: z.string().optional(), apiKey: z.string().min(1) }),
  }),
  /**
   * The ACCOUNT ROOT of an org (the top of its team ancestry; a flat org is its
   * own root) — what ops-center reserves the dashboards / alertRules /
   * alertDestinations feature quotas against. 404 for an unknown org.
   */
  orgAccountRoot: defineInternalEndpoint({
    id: 'platform.orgAccountRoot',
    service: 'platform',
    method: 'GET',
    path: '/internal/ops/org-account-root/:orgId',
    callers: ['ops-center'],
    auth: OPS_AUTH,
    params: z.object({ orgId: orgIdParam }),
    response: z.object({ orgId: z.string(), rootOrgId: z.string() }),
  }),
  /**
   * One audit-activity aggregation for an ops dashboard panel. The SCOPE is
   * the caller's verified identity as ops-center resolved it from the
   * user's token (`isSuperAdmin` sees every org; anyone else exactly `orgId`,
   * matched as the actor's org OR the affected org — the `GET /audit`
   * predicate). A non-sysadmin scope with no org yields an empty result.
   */
  auditActivity: defineInternalEndpoint({
    id: 'platform.auditActivity',
    service: 'platform',
    method: 'POST',
    path: '/internal/ops/audit-activity',
    callers: ['ops-center'],
    auth: OPS_AUTH,
    params: z.object({}),
    body: z.object({
      query: z.enum(AUDIT_ACTIVITY_QUERIES),
      scope: z.object({ isSuperAdmin: z.boolean(), orgId: z.string().min(1).max(64).optional() }),
      range: z.enum(AUDIT_ACTIVITY_RANGES),
      /** Query end, unix seconds. */
      end: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(AUDIT_ACTIVITY_MAX_LIMIT),
      vars: z.object({
        event: z.string().max(256).optional(),
        actor: z.string().max(256).optional(),
        requestId: z.string().max(256).optional(),
      }),
    }),
    response: AuditActivityResult,
  }),
  /**
   * Live (not soft-deleted) org ids in id order, at most `limit` — what a
   * sysadmin's `orgs=all` log view enumerates (Loki has no tenant wildcard).
   * Ids only, never names.
   */
  liveOrgIds: defineInternalEndpoint({
    id: 'platform.liveOrgIds',
    service: 'platform',
    method: 'GET',
    path: '/internal/ops/live-org-ids',
    callers: ['ops-center'],
    auth: OPS_AUTH,
    params: z.object({}),
    query: z.object({
      limit: z.unknown().optional().transform((v): number => {
        const n = Number(parseQueryString(v) ?? LIVE_ORG_IDS_MAX);
        return Number.isFinite(n) ? Math.min(LIVE_ORG_IDS_MAX, Math.max(1, Math.trunc(n))) : LIVE_ORG_IDS_MAX;
      }),
    }),
    response: z.object({ orgIds: z.array(z.string()) }),
  }),
} as const;
