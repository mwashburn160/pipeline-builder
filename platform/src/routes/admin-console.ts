// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /admin/console-check — the gateway's admin-console gate.
 *
 * nginx on the AWS targets fronts pgAdmin, mongo-express, Grafana and Kiali
 * (each a direct line to a datastore or to every tenant's telemetry). When an
 * operator leaves those routes on (ADMIN_CONSOLES_ENABLED, on by default), every
 * request to them first makes an `auth_request` subrequest HERE, carrying the
 * caller's access token (from the `pb_admin_console` cookie the dashboard sets
 * when a superadmin opens a console — nginx copies it into `Authorization`).
 * 204 lets the request through; anything else stops it at the gateway.
 *
 * The gate is the admin surface's own, plus one condition specific to the
 * consoles: an access token for a live session (requireAuth: signature, type,
 * tokenVersion) of a PLATFORM administrator (requireSystemAdmin; org admins do
 * not qualify) whose ACTIVE ORG is the system org (requireSystemOrg) and whose
 * session reached AAL2 (a second factor).
 *
 * WHY THE ACTIVE ORG TOO, when the superadmin flag already decides this.
 * Because this is the only route where a cross-tenant tool is handed to a
 * browser — one `auth_request` endpoint serving all five consoles, not one per
 * console — and the flag alone cannot say which hat the operator is
 * currently wearing. A superadmin browsing a tenant org holds a token minted in
 * THAT org; opening mongo-express from there is a datastore-wide session begun
 * from a tenant context, and the audit trail reads as if it happened inside that
 * tenant. Requiring the system org makes entering the console a DELIBERATE
 * context switch, exactly as the ecosystem-governance routes already do.
 *
 * It is defence in depth rather than a replacement, and the direction matters:
 * the flag is `select: false` with no write path (the user-update surface is
 * `.strict()` precisely so it cannot be set from outside), whereas membership
 * rows have many — OAuth invite-accept, domain auto-join, SCIM, SSO JIT. So the
 * two are ANDed. Gating on org alone would turn every org-join bug into
 * privilege escalation; gating on the flag alone is what we had.
 *
 * STILL READS NOTHING. `requireSystemOrg` compares the token's `organizationId`
 * claim, so this remains claim-only and cheap enough to run per request — which
 * it must be: `auth_request` fires on EVERY request, and a Grafana dashboard is
 * dozens of asset fetches. A membership lookup here would have been one indexed
 * query per asset. The claim is as fresh as the session, and removal from the
 * system org is already covered by the session-revocation path that `tokenVersion`
 * drives.
 */

import { audited, createLogger, dynamicAuthz, errorMessage, sendError, requireAssurance, requirePermission, requireSystemOrg } from '@pipeline-builder/api-core';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { audit } from '../helpers/audit.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';
import { incCounter } from '../observability/metrics.js';

const router: Router = Router();
/** Built once — `requirePermission` returns a middleware. */
const requireObservabilityConsole = requirePermission('observability_console:open');
const requireDatabaseConsole = requirePermission('database_console:open');
const requireObjectStoreConsole = requirePermission('objectstore_console:open');
const logger = createLogger('admin-console');

/** Shared with the dashboard (frontend/src/lib/admin-console.ts). */
const ADMIN_CONSOLE_COOKIE = 'pb_admin_console';
/** The caller's own access token, from the header `requireAuth` already read. */
function bearerFrom(req: Request): string | null {
  const header = req.header('Authorization') ?? '';
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}

/**
 * Say WHY the gate refused — nowhere else does, for this route.
 *
 * Two things conspire to make a refusal here silent. `requireAuth`'s common
 * rejections (bad signature, wrong token type, stale tokenVersion) answer 401
 * with no log at all; only the service-token and access-key paths log. And
 * `recordAuthzDenial` deliberately skips GET, so the audit trail does not
 * cover this route either.
 *
 * The caller cannot supply the missing detail: as an nginx `auth_request`
 * subrequest the response BODY is discarded, so the `ErrorCode` that
 * `sendError` puts there never reaches the browser — the operator sees a bare
 * 401 from the gateway and the platform says nothing. Debugging it meant
 * `exec`ing into the nginx pod and replaying the token by hand.
 *
 * So the reason is read off the refusal as it is written. `res.json` is the
 * single exit for every gate on this chain (`sendError` ends there), which is
 * why one wrapper catches all of them without touching the gates themselves —
 * they are shared with the rest of the admin surface and should not grow
 * route-specific logging.
 *
 * Logged, never audited: a failed console check is an operator-diagnostic
 * event, not a tenant action, and `requireSystemAdmin` already audits the
 * authorization refusal it is responsible for.
 */
function logRefusal(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const refusal = body as { code?: string; message?: string } | undefined;
    if (res.statusCode >= 400) {
      // The ONE channel that survives `auth_request`: nginx discards the body
      // but can lift a response header into a variable
      // (`auth_request_set $pb_deny_reason $upstream_http_x_pb_deny_reason`),
      // which is how the gateway tells the operator what to fix instead of
      // showing a bare 401. A code, never a message — this is attacker-visible
      // through the console's error page, and the codes are already public
      // vocabulary (`ErrorCode`), while messages are not.
      if (!res.headersSent) res.setHeader('X-PB-Deny-Reason', refusal?.code ?? `HTTP_${res.statusCode}`);
      logger.warn('Admin console check refused', {
        statusCode: res.statusCode,
        // The gate's own code: TOKEN_MISSING / TOKEN_INVALID / TOKEN_REVOKED
        // from requireAuth, SYSTEM_ORG_REQUIRED from the org gate, MFA_REQUIRED
        // from the assurance gate, or none for the system-admin 403 — which is
        // itself the distinguishing signal. SYSTEM_ORG_REQUIRED is the one an
        // operator can fix without help: switch to the system org and retry.
        code: refusal?.code,
        reason: refusal?.message,
        // Present only once a token verified, so its ABSENCE already narrows
        // the cause to the token itself. Never the token.
        userId: req.user?.sub,
        isSuperAdmin: req.user?.isSuperAdmin === true,
      });
    }
    return json(body);
  };
  next();
}

/**
 * The five consoles split into three classes, because the authority each one
 * needs differs by an order of magnitude.
 *
 * Before this they shared ONE gate, and that gate was the superadmin FLAG. So
 * "let them see the dashboards" also meant "let them read every tenant's rows
 * and delete the audit chain" — and the only way to grant the first was to grant
 * everything, impersonation included.
 *
 *  - Grafana and Kiali      -> `observability_console:open`. Read-only telemetry.
 *  - pgAdmin, mongo-express -> `database_console:open`. A read/write shell over
 *    every tenant's rows; the audit chain is elsewhere, so damage is recorded.
 *  - RustFS (S3)            -> `objectstore_console:open`. Holds the signed
 *    audit chain-head exports, which are what detects a truncated chain. Split
 *    from pgAdmin/mongo-express because those two are the two halves of the same
 *    tamper-evidence design — one shell can truncate the chain, the other can
 *    delete the heads that would expose it.
 *
 * All three are system-org-only and superadmins hold them implicitly, so nothing
 * an existing operator could do stops working. Only the first is in the seeded
 * Platform Operator bundle; the other two are granted by a superadmin composing
 * a Role for exactly that purpose.
 *
 * NOT A CONTAINMENT BOUNDARY — see the note in api-core's permission union. A
 * `database_console:open` holder can rewrite the `roles` collection and grant
 * itself the other two. The split keeps the default grant small and makes each
 * refusal legible; Object Lock is what defends the heads.
 */
const OBSERVABILITY_CONSOLE = /^\/(?:grafana|kiali)\//;
const DATABASE_CONSOLE = /^\/(?:pgadmin|mongo-express)\//;

/**
 * The classes the gateway may NAME, and the permission each requires.
 *
 * Keep in step with `X-PB-Console` in `deploy/aws/<target>/nginx/*.conf`. An
 * unrecognised value is not in this map and falls through to the flag below,
 * which fails safe.
 */
const STATED_CONSOLE: Record<string, ConsoleClass> = {
  observability: 'observability',
  database: 'database',
  objectstore: 'objectstore',
};

/**
 * Which console a request is for.
 *
 * SEPARATED from the permission it needs, so the class is a VALUE rather than
 * only a branch into a middleware. Two things need it: the gate below, and the
 * access metric/log on the success path — which previously could not say which
 * console had been entered because the class existed only as control flow.
 *
 * `unrecognised` is not an error: a console added to nginx and named neither
 * here nor in `X-PB-Console` is deliberately treated as the most dangerous
 * thing it could be.
 */
type ConsoleClass = 'observability' | 'database' | 'objectstore' | 'unrecognised';

/** The authority each class requires. Keyed, so a new class cannot be added
 *  without stating one. */
const CONSOLE_PERMISSION: Record<ConsoleClass, RequestHandler> = {
  observability: requireObservabilityConsole,
  database: requireDatabaseConsole,
  objectstore: requireObjectStoreConsole,
  // UNRECOGNISED PATHS FALL TO THE FLAG, deliberately — the safe direction for
  // a default, and how the RustFS console was protected before it was named.
  unrecognised: requireSystemAdmin,
};

/** Pure: reads only the headers the gateway sets, so both the gate and the
 *  success handler can call it without sharing state through the request. */
function consoleClassOf(req: Request): ConsoleClass {
  // The gateway STATES the class wherever a URI cannot carry it. The RustFS
  // console owns a whole server on :9001 and its own S3 client calls bare paths
  // — `GET /` is ListBuckets, objects are `/<bucket>/...` — so URI matching
  // alone would have admitted the console's UI and then refused every call it
  // makes. Checked FIRST, so a gateway that names its class is believed over any
  // path coincidence.
  const stated = STATED_CONSOLE[req.header('X-PB-Console') ?? ''];
  if (stated) return stated;
  // The four path-mounted consoles share one server, where the prefix is exact
  // and needs no header.
  const uri = req.header('X-Original-URI') ?? '';
  if (OBSERVABILITY_CONSOLE.test(uri)) return 'observability';
  if (DATABASE_CONSOLE.test(uri)) return 'database';
  return 'unrecognised';
}

function consoleGate(req: Request, res: Response, next: NextFunction): void {
  CONSOLE_PERMISSION[consoleClassOf(req)](req, res, next);
}

// The gate runs BEFORE `requireSystemOrg` deliberately: a tenant user who
// reaches this route is refused by it, so `system_org_guard_refused_total`
// counts only the case worth reading — a real platform operator holding a token
// minted in the wrong org.
router.get(
  '/',
  logRefusal,
  requireAuth,
  dynamicAuthz(
    'observability_console:open for /grafana/ and /kiali/; database_console:open for pgAdmin and '
      + 'mongo-express; objectstore_console:open for the RustFS object store; sysadmin for any '
      + 'unrecognised path. Which one applies comes from the GATEWAY — the `X-PB-Console` header '
      + 'it states, or the `X-Original-URI` it forwards — so no single id can gate the route.',
    {
      reachableBy: ['superadmin', 'system-org', 'gateway'],
      permissions: ['observability_console:open', 'database_console:open', 'objectstore_console:open'],
    },
  ),
  consoleGate,
  requireSystemOrg,
  requireAssurance({ minAssurance: 2 }),
  (req, res) => {
    // THE SUCCESS PATH WAS SILENT. Refusals were logged and the authorization
    // denial audited, but an ADMITTED request recorded nothing anywhere — no
    // log, no metric, no audit row. So "who opened pgAdmin, and when?" could
    // not be answered while every failed attempt could, which is backwards for
    // an incident review: the admitted access is the one that touched data.
    //
    // A COUNTER, not an audit row, and the reason is this handler's traffic.
    // `auth_request` fires on EVERY request the gateway proxies, so one Grafana
    // dashboard is dozens of calls through here — auditing each would write
    // dozens of rows per page view and bury the trail it was meant to create.
    // The counter costs nothing per call and answers "is console access
    // happening, and to what". Session-level attribution belongs at the point
    // the console cookie is minted, which is a separate change.
    //
    // Labelled by CLASS only — three bounded values. Not by user id, which
    // would be a series per operator, and not by URI, which is unbounded.
    // The log line below carries the user, where cardinality does not apply.
    const consoleClass = consoleClassOf(req);
    // GUARDED. `incCounter` throws when no metrics registry is wired, and this
    // handler is on the hot path of EVERY request the gateway proxies — a
    // metrics misconfiguration must not turn every admin console into a 500.
    // Same reasoning as the audit-chain counter: losing the count is
    // acceptable, losing the access is not.
    try {
      incCounter('admin_console_access_total', { console_class: consoleClass });
    } catch (err) {
      logger.debug('admin console access counter not emitted', { error: errorMessage(err) });
    }
    // INFO, so an incident can correlate the gateway's access log with the
    // platform's own record of who was admitted. `database` is the class worth
    // noticing: pgAdmin and mongo-express are a read/write shell over every
    // tenant's rows, and a READ leaves nothing behind in the audit chain.
    logger.info('Admin console access admitted', {
      consoleClass,
      userId: req.user?.sub,
      orgId: req.user?.organizationId,
    });
    res.status(204).end();
  },
);

/**
 * POST /admin/console-session — mint the console cookie, and AUDIT it.
 *
 * A SECOND ROUTER from this file, mounted at its own path rather than under the
 * check's `/admin/console-check`, where it would have read as
 * `console-check/session` — a session for the check, which is backwards: the
 * cookie is for the console. Same file, so it shares the class map, the gate and
 * the cookie name with the check it must stay in step with; nginx's
 * `auth_request` URL is untouched.
 *
 * WHY A ROUTE AT ALL. The cookie used to be set by the dashboard with
 * `document.cookie`, so entering a console produced no server-side event of any
 * kind. The only trace was the `auth_request` check above, which logs refusals
 * and counts admissions but cannot write an audit row per request — nginx fires
 * it on every asset, so one Grafana dashboard would write dozens. So "who
 * opened pgAdmin, and when?" was answerable from logs for 30 days and from the
 * audit trail never, while every FAILED attempt was audited. That is backwards:
 * the admitted session is the one that touched data.
 *
 * ONE ROW PER ENTRY. Opening a console is the only point where console access is
 * a discrete act, which is what makes it auditable at all. The dashboard still
 * re-writes the cookie itself when the access token ROTATES, and deliberately
 * does not come back here for it: a rotation is the same operator in the same
 * org continuing the same session, so a row for it would add volume without
 * adding a fact.
 *
 * THE SAME GATE as the check, reusing the identical chain rather than a similar
 * one — a mint endpoint weaker than the gate it mints for would be the way
 * around that gate. Note what this does NOT grant: the cookie carries the
 * caller's OWN access token, and the gateway re-evaluates class, permission,
 * org and assurance on every request. So a caller that names a cheap class here
 * and then browses an expensive console is refused per request by the check
 * above; what it buys is a row naming the class it asked for, contradicted in
 * the same log by the refusals. Attribution of WHO is exact; of WHICH console,
 * as truthful as the caller.
 *
 * NOT HttpOnly, which is the one flag that looks missing. The dashboard reads
 * this cookie back to follow token rotation and to know a console was opened at
 * all, so HttpOnly would break that path — and it would buy little: the token in
 * it is the same access token the SPA already holds, so script on this origin
 * has it either way.
 */
export const adminConsoleSessionRouter: Router = Router();
adminConsoleSessionRouter.post(
  '/',
  requireAuth,
  dynamicAuthz(
    'The same chain as the console check: observability_console:open, '
      + 'database_console:open or objectstore_console:open by the class the caller '
      + 'states in `X-PB-Console`, sysadmin for an unrecognised one, plus the '
      + 'system org and AAL2.',
    {
      reachableBy: ['superadmin', 'system-org'],
      permissions: ['observability_console:open', 'database_console:open', 'objectstore_console:open'],
    },
  ),
  consoleGate,
  requireSystemOrg,
  requireAssurance({ minAssurance: 2 }),
  // DECLARATION ONLY — `audited` tags the route for the coverage contract and
  // writes nothing; the handler below writes the row.
  audited('admin.console.session'),
  (req, res) => {
    const token = bearerFrom(req);
    if (!token) {
      // Unreachable through `requireAuth`'s bearer path; reachable if the route
      // is ever mounted behind a different credential (a service token has no
      // bearer to hand on), and a cookie set from nothing would 401 at the
      // gateway with nothing to explain it.
      sendError(res, 400, 'A bearer access token is required to open a console', 'TOKEN_MISSING');
      return;
    }
    // A COOKIE MUST NOT OUTLIVE ITS TOKEN: past `exp` the gateway answers 401
    // on every asset and the console looks broken rather than expired. Same
    // rule the dashboard applied client-side, now enforced where the claim is
    // already verified.
    const secondsLeft = Math.max(0, Math.floor((req.user?.exp ?? 0) - Date.now() / 1000));
    if (secondsLeft <= 0) {
      sendError(res, 401, 'Token has expired', 'TOKEN_EXPIRED');
      return;
    }
    const consoleClass = consoleClassOf(req);
    // AUDITED BEFORE the cookie is handed over. `audit` is fire-and-forget, so
    // this is ordering rather than a guarantee — but it keeps the write ahead of
    // the grant, which is the right direction for a record that exists to
    // attribute cross-tenant access.
    audit(req, 'admin.console.session', {
      targetType: 'admin-console',
      targetId: consoleClass,
      details: { consoleClass, expiresInSeconds: secondsLeft },
    });
    logger.info('Admin console session minted', {
      consoleClass,
      userId: req.user?.sub,
      orgId: req.user?.organizationId,
      expiresInSeconds: secondsLeft,
    });
    res.cookie(ADMIN_CONSOLE_COOKIE, token, {
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: secondsLeft * 1000,
    });
    res.status(204).end();
  },
);

export default router;
