// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator consoles (pgAdmin, mongo-express, Grafana, Kiali) behind the AWS
 * gateway, and the cookie that lets a platform administrator through it.
 *
 * nginx fronts each console with an `auth_request` to platform's
 * `GET /admin/console-check` (a console permission + system-org + AAL2), carrying
 * the bearer from the `pb_admin_console` cookie
 * (deploy/aws/<target>/nginx/admin-uis.conf) and stripping it before proxying, so
 * no console ever sees a platform credential.
 *
 * The cookie holds the CURRENT access token, so it lives exactly as long as that
 * token: `Max-Age` never outlasts the token's `exp`, it is re-written when the
 * token rotates while set (refresh, a sibling tab's handoff) and removed when
 * the session ends or changes org. It is set only when a sysadmin opens a
 * console — nobody else ever carries it.
 */

import { isAwsTarget } from '@/lib/deploy-target';
import { decodeJwt } from '@/lib/jwt';

export const ADMIN_CONSOLE_COOKIE = 'pb_admin_console';

/**
 * The three classes the consoles split into, by blast radius. Keep in step with
 * `STATED_CONSOLE` and the URI patterns in platform's `routes/admin-console.ts`.
 */
export type ConsoleClass = 'observability' | 'database' | 'objectstore';

export interface AdminConsole {
  id: 'grafana' | 'kiali' | 'pgadmin' | 'mongo-express' | 'rustfs';
  label: string;
  /**
   * Where the gateway serves it.
   *
   * `{ sameOriginPath }` is a `location` on the main gateway — four of the five.
   * `{ port, path }` is a whole nginx `server` on its own port, which is what the
   * RustFS console needs: its UI resolves the S3/admin API from
   * `window.location` and then calls ROOT paths (`GET /` is ListBuckets,
   * objects are `/<bucket>/...`), so the origin serving it must have RustFS at
   * its root. Under a sub-path the assets load and every API call lands on the
   * platform. Grafana and Kiali have knobs for this (`serve_from_sub_path`,
   * `web_root`); RustFS has none, and `RUSTFS_CONSOLE_PREFIX` is refused at
   * startup because `/rustfs/*` is its own internode RPC namespace.
   */
  at: { sameOriginPath: string } | { port: number; path: string };
  description: string;
  /**
   * The permission class the gateway requires for THIS console, matching
   * platform's `consoleGate`. Each maps to one system-org-only permission:
   * `observability_console:open`, `database_console:open` or `objectstore_console:open`.
   * Superadmins hold all three implicitly; only the first is in the seeded
   * Platform Operator Role.
   *
   * The gateway is the authority — this only decides which tiles to RENDER, so
   * a mismatch shows a tile that then refuses rather than granting anything.
   */
  requires: ConsoleClass;
  /** Targets whose gateway serves this console at all. */
  servedOn: readonly DeployTarget[];
}

/** The deploy targets that serve any console. */
export type DeployTarget = 'aws-ec2' | 'aws-eks' | 'minikube' | 'docker';

/**
 * ALL FIVE operator consoles, on every target that serves them.
 *
 * `servedOn` is per console because the set genuinely differs: the docker
 * compose stack runs no Istio, so it has no Kiali to link to. Listing it here
 * rather than filtering at the call site keeps "what does this target serve"
 * answerable in one place, and a tile for something that is not deployed is a
 * link to a 502.
 */
const ALL_TARGETS: readonly DeployTarget[] = ['aws-ec2', 'aws-eks', 'minikube', 'docker'];

export const ADMIN_CONSOLES: readonly AdminConsole[] = [
  { id: 'grafana', label: 'Grafana', at: { sameOriginPath: '/grafana/' }, description: 'Dashboards over every tenant’s metrics and logs.', requires: 'observability', servedOn: ALL_TARGETS },
  // No Istio in the compose stack, so no mesh console to point at.
  { id: 'kiali', label: 'Kiali', at: { sameOriginPath: '/kiali/' }, description: 'The service mesh: traffic, mTLS and routing.', requires: 'observability', servedOn: ['aws-ec2', 'aws-eks', 'minikube'] },
  { id: 'pgadmin', label: 'pgAdmin', at: { sameOriginPath: '/pgadmin/' }, description: 'The PostgreSQL database, directly.', requires: 'database', servedOn: ALL_TARGETS },
  { id: 'mongo-express', label: 'mongo-express', at: { sameOriginPath: '/mongo-express/' }, description: 'The MongoDB database, directly.', requires: 'database', servedOn: ALL_TARGETS },
  {
    id: 'rustfs',
    label: 'RustFS',
    at: { port: 9001, path: '/rustfs/console/' },
    description: 'The object store: registry, Loki, Thanos, plugin builds and the audit chain heads.',
    requires: 'objectstore',
    servedOn: ALL_TARGETS,
  },
];

/**
 * How a browser reaches `console_` on `target` — a link, or a command.
 *
 * The distinction is the whole reason this function exists. Four consoles are a
 * path on the origin the dashboard is already served from, so their link is
 * always right. The RustFS console lives on :9001, and whether that port is
 * reachable from a browser is a property of the TARGET, not of the console:
 *
 *  - **aws-ec2** publishes it as a second HTTPS ALB listener.
 *  - **docker** publishes it on loopback (`127.0.0.1:9001`).
 *  - **minikube** gets `nginx 9001:9001` from `pb_console_port_forwards`
 *    (deploy/bin/k8s-resources.sh), which both `setup.sh` and `startup.sh` call —
 *    so it is as reachable as the gateway itself, on `localhost`.
 *  - **aws-eks** deliberately has no listener for it. An ALB rule cannot be
 *    scoped to one listener in a group, so a second listener would also answer
 *    the app's own root path, and the alternatives are unverified on EKS Auto
 *    Mode — a silently ignored `group.name` provisions a second ALB on a name
 *    the certificate does not cover.
 *
 * So eks alone gets the command rather than a dead "Open" button that fails with
 * a connection error the operator has to diagnose. Returning it as DATA (rather
 * than hiding the tile, which is what used to happen) means the console is
 * listed, its authority is stated, and the one extra step is written down where
 * it is needed.
 */
export type ConsoleAccess =
  | { kind: 'link'; href: string }
  | { kind: 'port-forward'; command: string; note: string };

/** Targets where :9001 is reachable from a browser without an extra step. */
const PORT_9001_PUBLISHED: readonly DeployTarget[] = ['aws-ec2', 'docker', 'minikube'];

export function consoleAccess(console_: AdminConsole, target: string, origin?: { protocol: string; hostname: string }): ConsoleAccess {
  if ('sameOriginPath' in console_.at) return { kind: 'link', href: console_.at.sameOriginPath };
  const { port, path } = console_.at;
  if ((PORT_9001_PUBLISHED as readonly string[]).includes(target)) {
    // Built from the CURRENT origin rather than from config: one prebuilt image
    // serves every deploy, and only the browser knows which domain it was
    // reached on (an operator may be on the ALB name, a CNAME or localhost).
    const loc = origin ?? (typeof window === 'undefined' ? undefined : window.location);
    const protocol = loc?.protocol ?? 'https:';
    const hostname = loc?.hostname ?? 'localhost';
    return { kind: 'link', href: `${protocol}//${hostname}:${port}${path}` };
  }
  return {
    kind: 'port-forward',
    command: `kubectl port-forward -n pipeline-builder svc/nginx ${port}:${port}`,
    note: `Then open https://localhost:${port}${path}`,
  };
}

/**
 * Whether the GATEWAY enforces the console gate on this target.
 *
 * Only the AWS trees put the consoles behind the `auth_request` to
 * `/admin/console-check`; on minikube and docker the same `location` blocks are
 * served unauthenticated, because reaching those gateways already means local
 * access to the cluster or the host.
 *
 * It matters here for one reason: the `pb_admin_console` cookie and the AAL2
 * precondition exist to satisfy that gate. Demanding them on a target that does
 * not check anything would refuse a developer with no second factor enrolled a
 * console that is, in fact, wide open — a gate in the UI that is not a gate
 * anywhere else.
 */
export function consolesAreGated(deployTarget: string): boolean {
  return isAwsTarget(deployTarget);
}

/**
 * The consoles to RENDER: what this target serves, intersected with what the
 * viewer holds.
 *
 * TWO filters, and keeping them separate is the point. `servedOn` is a property
 * of the deployment — a tile for a console that is not running is a link to a
 * 502, and no permission makes it work. `requires` is a property of the viewer,
 * driven by the permission CLASS rather than by id so a console added to
 * `ADMIN_CONSOLES` is gated automatically.
 *
 * Superadmins hold every class implicitly — the same way `requirePermission`
 * treats the flag — so they skip the permission filter but not the target one.
 */
export function visibleConsoles(opts: {
  deployTarget: string;
  isSuperAdmin: boolean;
  canObservability: boolean;
  canDatabase: boolean;
  canObjectStore: boolean;
}): readonly AdminConsole[] {
  const onTarget = ADMIN_CONSOLES.filter(
    (c) => (c.servedOn as readonly string[]).includes(opts.deployTarget),
  );
  if (opts.isSuperAdmin) return onTarget;
  const held: Record<ConsoleClass, boolean> = {
    observability: opts.canObservability,
    database: opts.canDatabase,
    objectstore: opts.canObjectStore,
  };
  return onTarget.filter((c) => held[c.requires]);
}

/**
 * Whether this target serves operator consoles at all.
 *
 * Derived from `ADMIN_CONSOLES` rather than from a target list, so adding a
 * console on a new target cannot leave the card hidden. All four known targets
 * serve some; an unknown one serves none, which is the right default for a
 * deployment this build has never heard of.
 */
export function adminConsolesAvailable(deployTarget: string): boolean {
  return ADMIN_CONSOLES.some((c) => (c.servedOn as readonly string[]).includes(deployTarget));
}

/** Seconds until the token expires (0 when it is expired or unreadable). */
export function tokenSecondsLeft(token: string, nowMs = Date.now()): number {
  const exp = decodeJwt(token)?.payload?.exp;
  if (typeof exp !== 'number') return 0;
  return Math.max(0, Math.floor(exp - nowMs / 1000));
}

/**
 * Write the console cookie for `token`. Returns false (and clears any old
 * cookie) when the token has no time left — a cookie that outlives its token
 * would only make the gateway answer 401.
 */
export function setAdminConsoleCookie(token: string, nowMs = Date.now()): boolean {
  const maxAge = tokenSecondsLeft(token, nowMs);
  if (maxAge <= 0) {
    clearAdminConsoleCookie();
    return false;
  }
  document.cookie = `${ADMIN_CONSOLE_COOKIE}=${encodeURIComponent(token)}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return true;
}

export function clearAdminConsoleCookie(): void {
  document.cookie = `${ADMIN_CONSOLE_COOKIE}=; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** The token the cookie currently carries, if any. */
function cookieToken(): string | null {
  const raw = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${ADMIN_CONSOLE_COOKIE}=`));
  const value = raw ? raw.slice(ADMIN_CONSOLE_COOKIE.length + 1) : '';
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

/**
 * Keep an already-set cookie in step with the access token (wired to
 * `api.onAccessTokenChange`): re-written for a rotated token of the SAME person
 * in the SAME org; dropped on sign-out, an org switch or an impersonation token.
 * Nothing is written unless a console was opened — no cookie, nothing to follow.
 *
 * It deliberately does NOT require `isSuperAdmin`. It used to, from when the
 * consoles were flag-gated, and that is now a defect rather than a precaution: a
 * **Console Administrator** holds `database_console:open` without the flag, so
 * the first token rotation mid-session would drop their cookie and the next
 * console request would 401 with nothing to explain it. Keeping the cookie for a
 * non-superadmin grants nothing either — the gateway re-checks the permission,
 * the system org and the assurance level on EVERY request, so a cookie for
 * someone who has lost the permission just gets refused.
 *
 * What it still refuses to follow is a change of PRINCIPAL: a different `sub`, a
 * different org, or an impersonation token (whose holder is acting as someone
 * else and must not carry a console credential into that session).
 */
export function syncAdminConsoleCookie(token: string | null): void {
  if (typeof document === 'undefined') return;
  const current = cookieToken();
  if (!current) return;
  if (!token) { clearAdminConsoleCookie(); return; }
  type Claims = { sub?: string; organizationId?: string; impersonationReadOnly?: boolean; impersonatorId?: string };
  const was = decodeJwt(current)?.payload as Claims | undefined;
  const now = decodeJwt(token)?.payload as Claims | undefined;
  const same = !!was && !!now && !now.impersonationReadOnly && !now.impersonatorId
    && was.sub === now.sub && was.organizationId === now.organizationId;
  if (!same) { clearAdminConsoleCookie(); return; }
  setAdminConsoleCookie(token);
}
