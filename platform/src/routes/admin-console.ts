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

import { createLogger, dynamicAuthz, requireAssurance, requirePermission, requireSystemOrg } from '@pipeline-builder/api-core';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router();
/** Built once — `requirePermission` returns a middleware. */
const requireObservabilityConsole = requirePermission('observability_console:open');
const requireDatabaseConsole = requirePermission('database_console:open');
const requireObjectStoreConsole = requirePermission('objectstore_console:open');
const logger = createLogger('admin-console');

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
const STATED_CONSOLE: Record<string, RequestHandler> = {
  observability: requireObservabilityConsole,
  database: requireDatabaseConsole,
  objectstore: requireObjectStoreConsole,
};

function consoleGate(req: Request, res: Response, next: NextFunction): void {
  // The gateway STATES the class wherever a URI cannot carry it. The RustFS
  // console owns a whole server on :9001 and its own S3 client calls bare paths
  // — `GET /` is ListBuckets, objects are `/<bucket>/...` — so URI matching
  // alone would have admitted the console's UI and then refused every call it
  // makes. Checked FIRST, so a gateway that names its class is believed over any
  // path coincidence.
  const stated = STATED_CONSOLE[req.header('X-PB-Console') ?? ''];
  if (stated) {
    stated(req, res, next);
    return;
  }
  // The four path-mounted consoles share one server, where the prefix is exact
  // and needs no header.
  const uri = req.header('X-Original-URI') ?? '';
  if (OBSERVABILITY_CONSOLE.test(uri)) {
    requireObservabilityConsole(req, res, next);
    return;
  }
  if (DATABASE_CONSOLE.test(uri)) {
    requireDatabaseConsole(req, res, next);
    return;
  }
  // UNRECOGNISED PATHS STILL FALL TO THE FLAG, deliberately. A console added to
  // nginx without being named either here or in `X-PB-Console` is treated as the
  // most dangerous thing it could be, which is the safe direction for a default
  // — and it is how the RustFS console was protected before it was named above.
  requireSystemAdmin(req, res, next);
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
  (_req, res) => {
    res.status(204).end();
  },
);

export default router;
