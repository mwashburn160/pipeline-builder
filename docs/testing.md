# Testing Conventions

How the test suite is wired, and the conventions that keep it honest. ~800 test
files, ~9,700 tests, 18 jest projects. Everything here is enforced by a lint rule
or a test unless it says otherwise.

- [Module mocks: always spread the real module](#module-mocks-always-spread-the-real-module)
- [The shared mock factories](#the-shared-mock-factories)
- [Authorization gates run for real](#authorization-gates-run-for-real)
- [Coverage thresholds](#coverage-thresholds)
- [When integration tests run](#when-integration-tests-run)
- [The permission contract](#the-permission-contract)
- [Mock hygiene](#mock-hygiene)
- [Traps worth knowing](#traps-worth-knowing)

---

## Module mocks: always spread the real module

`jest.unstable_mockModule(spec, factory)` replaces the **entire** namespace. A
factory returning a bare object literal therefore silently turns every export it
forgot into `undefined` — and the failure surfaces later, in an unrelated change,
as `does not provide an export named X` at link time.

This is not hypothetical. It has broken the build repeatedly:

| Module | What happened |
|---|---|
| `drizzle-orm` | 18 suites hand-listed operators; `desc` was in 6 and missing from 12. Production code reached for `desc` and twelve suites failed to load. |
| `@pipeline-builder/api-core` | 12 forked `mock-api-core.ts` files, 23–61 keys each, against a barrel exporting ~357 symbols. |
| `@pipeline-builder/api-server` | Billing suites mocked it with a literal holding only `withRoute`. The day `billing-helpers.ts` added `import { incCounter }`, four suites failed to load. |

**The rule:** start from the real module, overlay only what you assert on.

```ts
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  eq: (col, val) => ({ _kind: 'eq', col, val }),   // only what this suite inspects
}));
```

`no-restricted-syntax` in `.projenrc.ts` **fails the build** on an inline object
literal for `drizzle-orm` or `@pipeline-builder/api-core`. It runs through the
projen `eslint` task, which the `build` target spawns — so CI enforces it.

> Running eslint by hand needs `ESLINT_USE_FLAT_CONFIG=false`, because ESLint 9
> defaults to flat config while this repo uses `.eslintrc.json`. Bare `npx eslint`
> fails with "couldn't find an eslint.config.js" — that is the invocation, not the
> tooling:
> `ESLINT_USE_FLAT_CONFIG=false npx eslint --ext .ts,.tsx src test`

### Not covered by the rule (deliberately)

`@pipeline-builder/api-server` and `@pipeline-builder/pipeline-data` carry the
same hazard but are **not** lint-enforced. They are the framework/DB boundary a
unit test legitimately replaces wholesale: spreading the real module drags in
Express and Postgres wiring the suite exists to avoid. Enforcing it would mean
~154 migrations, many of them wrong. Spread them where you reasonably can; know
the hazard where you can't.

`api/billing` cannot spread `src/helpers/billing-helpers.js` at all — the full
rationale is in `api/billing/test/helpers/mock-api-core.ts`. Short version: that
module validates config at import, so `requireActual` only works inside a window
between the suite's `config.js` mock and its `await import(SUT)`, and several
suites have no such window. Fixing it properly means changing production source.

## The shared mock factories

They live in `packages/api-core/src/testing/` and are imported through the **deep
built path**, which a suite's `@pipeline-builder/api-core` module mock does *not*
intercept — so a factory can read the real module without recursing into its own
mock:

```ts
import { drizzleMock } from '@pipeline-builder/api-core/lib/testing/mock-drizzle.js';
```

| Factory | Use |
|---|---|
| `mock-drizzle.ts` → `drizzleMock(overrides)` | Every `drizzle-orm` mock. |
| `mock-api-core.ts` → `baseApiCoreMock` / `primitiveApiCoreMock`, plus shared defaults, error classes and gate helpers | Backs each project's `test/helpers/mock-api-core.ts`. |
| `tier-mock.ts` | Complete `QUOTA_TIERS` / tier lists sourced from the real `VALID_TIERS`. |

A project's `test/helpers/mock-api-core.ts` is a thin wrapper holding only its own
defaults:

```ts
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;

export function apiCoreMock(overrides: Record<string, unknown> = {}) {
  return baseApiCoreMock(actualApiCore, { ...projectDefaults(), ...overrides });
}
```

**`requireActual` is resolved in the project helper, not inside the factory, and
that placement is load-bearing.** `requireActual` on an ESM barrel only succeeds
when nothing else is mid-`import()` of it. The project helper is a static import
of the test file, evaluated before any `await import(SUT)` — the one point where
that reliably holds. Resolving it inside the shared factory races the loader in
some suites (`Cannot require() ES Module … currently being loaded by a concurrent
import()`); resolving it lazily breaks suites that mock a node builtin such as
`https`, because the real barrel then links against the suite's partial stub.

> jest 30.4.x has **no `jest.importActual`** — only `requireActual`.

## Authorization gates run for real

Platform controller suites mock `helpers/controller-helper.js` through
`platform/test/helpers/controller-helper-mock.ts`, which returns the **real
module with nothing faked**.

Before this, ~50 suites replaced it with a two-function stub. That disabled nine
tenancy/authz gates (`requireAuth`, `requireSystemAdmin`, `requireOrgMembership`,
`requireAuthContext`, `requireAdminContext`, `requireMemberManagementScope`,
`canAdministerOrg`, `canManageOrgScope`, `canAccessOrg`) in exactly the suites
that looked like they tested them. Restoring them turned up **11 suites covering
admin-gated endpoints that never once constructed an authorized caller** — the
gate coverage they appeared to provide was zero.

**Express authority in the request fixture, never by stubbing a gate:**

| Gate | What the fixture needs |
|---|---|
| `requireAuth`, `requireAuthUserId` | `req.user` (with `sub`), else 401 |
| `requireSystemAdmin` | `user.isSuperAdmin === true` |
| `isOrgAdmin` | `user.role` of `'admin'`/`'owner'`, not a sysadmin, not the system org |
| `requireOrgMembership`, `requireAuthContext` | `user.organizationId` |
| `requireAdminContext` | sysadmin **or** org admin |
| `requireMemberManagementScope` | sysadmin → fleet-wide; else `user.organizationId` |
| `canAdministerOrg` | sysadmin, **or** org admin of that exact org, **or** admin of an ancestor |
| `canManageOrgScope` | sysadmin, **or** same org, **or** descendant — **no role check** (delegated permissions are honoured) |
| `canAccessOrg` | sysadmin, **or** same org, **or** org admin of an ancestor |

`withController` is **not** faked either: it plus `handleControllerError` and the
route's `errorMap` are production logic, and ~15 suites assert exactly that
mapping (`OIDC_NOT_ENTITLED` → 403, `USER_OWNER_HAS_ORGS` → 400, …). A suite that
genuinely needs to observe a raw throw opts in:

```ts
controllerHelperMock({ withController: rawThrowController })
```

**Every suite covering a gated endpoint carries at least one negative case** — an
unauthorized caller gets 401/403 and the service/DB is never touched. A gate with
only happy-path coverage is a gate nobody has tested.

## Coverage thresholds

`coverageThreshold` is set per project in `.projenrc.ts` and pinned at the
**current measured value rounded down to a whole percent**. It is a **ratchet**:
it exists to stop coverage sliding, not to hit a number. Raise it when you raise
coverage; never lower it to make a red build green — find what stopped being
covered.

Security-critical files carry per-path thresholds around 90%:
`packages/api-core/src/utils/audit.ts`, `platform/src/services/scim-service.ts`,
`platform/src/services/mfa-recovery.ts`,
`platform/src/controllers/token-exchange.ts`,
`api/billing/src/helpers/{stripe-invoice-handlers,billing-ledger}.ts`,
`api/billing/src/routes/stripe-webhook.ts`,
`api/image-registry/src/routes/token.ts`.

## When integration tests run

Suites named `*.integration.test.ts` need a real MongoDB
(`mongodb-memory-server`) and are gated on `RUN_MONGO_INTEGRATION`.

- **Locally:** skipped unless you set `RUN_MONGO_INTEGRATION=1`.
- **In CI:** `.github/workflows/test.yml` sets it, and the suites **fail** rather
  than skip if `CI` is set without it. A gated suite that quietly degrades to
  "green and empty" is worse than no suite at all — that is the failure mode this
  guard exists to prevent.

## The permission contract

`frontend/src/generated/route-table/<service>.json` is **generated** from the
routes. That makes permission *weakening* invisible: relax a route's gate and the
table regenerates to match, so the diff looks like the change was intended.

`docs/permission-contract.md` is the human-maintained counterpart. It records the
permission each sensitive route requires, and a test compares it against the
generated table. Weakening a gate therefore fails the build until a human edits
the contract **in the same commit** — which is the point: the contract edit is the
reviewable artifact.

**Review rule:** a diff touching `docs/permission-contract.md` is a permission
change. Review it as a security change, and ask what a caller can now reach that
they could not before.

## Parity mechanisms

Three checks exist because a *tag* is not a *behaviour*. Each says plainly what
it proves, because a guard that oversells itself is worse than none.

| Check | Proves | Does **not** prove |
|---|---|---|
| `packages/api-core/test/gate-denial.test.ts` | Each tagged gate (`requirePermission`, `requireAllPermissions`, `requirePermissionOrService`, `requireSystemAdmin`, `requireServicePrincipal`, `requireInternalService`, `requireFeature`) really refuses an unqualified caller and never calls `next`, and its advertised metadata matches the gate built | That any particular route mounts it |
| `frontend/test/permission-contract.test.ts` | The hand-written contract and the generated route tables agree on every gated route's full authorization posture | — |
| `frontend/test/audit-action-parity.test.ts` | Every `audited('x')` action is referenced by its service somewhere other than the declaration — catching typos and orphaned declarations | That the emitting path is *reachable from that route*, or runs |
| `frontend/test/route-permissions.test.tsx` | Every mapped UI control really disappears for a viewer without its permission (it is **rendered twice**), and every write route in every service is either mapped to such a control or categorized | That a control's click reaches the route it is mapped to — the mapping is hand-written |

The audit check is deliberately a cheap ratchet. Proving actual emission means
driving all 207 audited routes with authorized fixtures and asserting on the
audit sink; that is a much larger piece of work and is **not** done. Do not read
a green run as audit-emission coverage.

### UI gate ↔ API gate parity

`frontend/test/route-permissions.test.tsx` is the control-side guard, and it
works in two halves.

**1. Each mapped control is rendered, not grepped.** Every row in `CONTROLS`
carries a `behaviour` block, and the suite renders the owning page twice — once
for a viewer holding the permission, once without — asserting the control is
there and then gone. The check used to be
`expect(source).toContain("can('x')")`, which is text in a file: it passed on a
`can('x')` left in a comment or a tooltip after the JSX around it had been
deleted. **All 55 mapped controls are covered this way** — 22 distinct pages
plus five components that own a control no page can reach (the sidebar, the team
settings drawer, the plugin create modal, the per-pipeline scorecard card and the
team usage card). The two renders are the point: a row that cannot show the
control disappearing is a row that proves nothing.

The harness is uniform so a row stays a few lines of data. One set of module
mocks supplies the page shell (`useAuthGuard`, `useAuth`, `useFeatures`,
`useOrgHierarchy`, `next/router`, `next/dynamic`, `framer-motion`) plus a
permissive `@/lib/api` proxy whose answers come from `API_DEFAULTS` overlaid
with the row's own `api` payloads. A row adds only what its surface needs:

- `mount` — the page, or the smallest component that owns the control. A
  component mount must say why in `renders`; without that note the default
  reading is "the page was rendered, so the page's mount-site gate ran".
- `find` — how the control is located, by role and accessible name.
- `absence` — `'removed'` (default) or `'disabled'`, for the surfaces that
  deliberately keep a control visible and inert so the reason can be shown.
- `gatedOn` — the permission withheld in the second render; `'systemAdmin'` /
  `'admin'` for a role gate (the page renders `AccessDenied`), or `'feature'`
  for a control whose only gate is an entitlement.
- `reveal` — an interaction needed first (open a row menu, fill the field a
  submit waits on). It runs in **both** renders, so it cannot smuggle in the
  permission under test.

One more thing the file does deliberately: a block of `jest.mock` stubs for leaf
components no row asserts on (the log rows, the plan grid, the org-detail cards,
the pipeline form-builder tabs). They carry no permission decision, so stubbing
them changes nothing the suite claims — and it keeps the suite's footprint to
the surfaces it actually exercises instead of every module a page transitively
imports. The frontend's coverage floor is measured over the files tests load, so
a breadth test that drags in ~6,000 statements of untouched editors would push
the global percentage down without anyone having covered less.

**2. Every write route is accounted for.** The rule is no longer limited to
routes carrying a feature / step-up / scope / assurance gate: all 293 write
routes across the ten services must be either mapped to a control or given a
`ROUTE_DISPOSITIONS` entry — a named category plus the caller that was actually
looked up. The categories are `machine-only`, `machine-credential`,
`external-callback`, `pre-session`, `session-plumbing`, `own-account`,
`step-up-resume`, `sysadmin-console`, `same-control` and `no-ui`.

Two rules keep the registry from becoming a rubber stamp: a `same-control` entry
must name a `CONTROLS` row that really exists (so leaning on another control's
gate means leaning on a gate this file proves), and a `machine-only` entry is
checked against the route table's own `internalCallers` / `servicePrincipal`.
Reasons are required to be long enough to name a file or a caller, so "N/A"
cannot pass.

### Write routes with no UI caller

Found by looking, and recorded as `no-ui` dispositions. None is reachable from
the dashboard:

| Route | What drives it |
|---|---|
| `platform POST /auth/device/code`, `POST /auth/device/token` | The CLI's device-authorization grant. The dashboard drives only the human half (`/auth/device/authorize`, approve, deny). |
| `platform POST /auth/token/exchange` | Service-account token exchange. |
| `platform POST /auth/key/rotate`, `POST /auth/key/revoke` | Unattended service-account key self-rotation/revocation — the audit-event text says explicitly that no person is present. |
| `platform POST /user/generate-token` | CLI / renewal-Lambda machine-credential mint. |
| `platform POST /organization/names` | Batch org-id → name resolver, called service-to-service only. **Unlike its peers it is not marked service-principal in the route table**, so any authenticated caller can resolve org names. |
| `compliance POST /compliance/validate/pipeline`, `POST /compliance/validate/plugin` | The enforcing (non dry-run) validation, called by the CDK at deploy time. The client layer only has the `/dry-run` variants. |
| `plugin POST /plugins/lookup` | Deploy-time PluginLookup Lambda call from the CDK. |
| `ask POST /ask`, `POST /ask/stream` | API / CLI answer endpoints; the dashboard's Ask panel drives only `/ask/agent/stream`. |

### Known UI ↔ route gate mismatches

`KNOWN_UI_GATE_MISMATCHES` pins the routes whose control checks a *different*
gate from the one the route enforces. It is a findings list, not an allowlist:
the count is asserted, so a new mismatch fails the build, and fixing one fails
until the entry is removed. The costly direction is **LOOSER** — a control shown
to someone the API will refuse:

- `compliance POST /compliance/scans/:id/cancel` — `ScanDetail` renders
  "Cancel scan" with no gate at all (it takes no `readOnly` prop), on a
  `compliance:read` page, against a `compliance:write` route.
- `message PATCH /messages/:id`, `POST /messages/:id/reply`,
  `POST /messages/attachments` — the thread edit / reply composer / attach
  control are not wrapped in `canWrite`; page gate `messages:read` vs route
  `messages:write`.
- `plugin POST /plugins/deploy-generated` — the "Create" action on a plugin
  proposal in `AskPanel` is gated only by the `ai_generation` entitlement, not
  by `plugins:write`. The Create-plugin modal's own path is gated.

The rest are STRICTER (the UI asks for more than the route does, e.g. the
registry console and the build-queue replay/retry gate on system admin where
the route asks for `registry:write` / `plugins:write`) or DIFFERENT
(`POST /pipeline-templates/:id/instantiate` is gated on `pipelines:write` while
the route requires `templates:read`).

## Mock hygiene

Set repo-wide via projen, so they apply to every project:

- **`clearMocks: true`** — call history reset between tests.
- **`restoreMocks: true`** — a `jest.spyOn(...).mockImplementation(...)` is undone
  after each test, so a spy cannot leak into the next test or the next file.
- **`jest-env-guard.js`** (a `setupFilesAfterEnv` entry) snapshots `process.env`
  as each file starts and restores it when the file ends. A jest worker runs many
  files in one process and `process.env` is process-global — the one piece of
  state jest cannot reset for us. Without this, a suite that sets an env var
  changes how a later file behaves, and suites pass or fail on the file order
  jest happened to pick. A suite needing per-*test* isolation still saves and
  restores in its own `beforeEach`/`afterEach`.

## Traps worth knowing

Each of these cost someone real debugging time.

**`undefined` is not "anonymous".** A fixture helper shaped
`req(body, user = SOME_ADMIN)` given an explicit `undefined` silently re-triggers
the default and runs as the admin. The test then sails past the gate and dies on
some unprimed mock — surfacing as a **500**, which reads like an error-map bug.
Pass `null` for an anonymous caller.

**Any `org-hierarchy.js` mock must export `isAncestorOrg`.** `canAdministerOrg`,
`canManageOrgScope` and `canAccessOrg` lazily `await import('./org-hierarchy.js')`
**only on the cross-org branch**. A mock that provides some other export but omits
`isAncestorOrg` yields **500 instead of 403 on cross-org cases**, while same-org
and sysadmin cases pass — because those short-circuit before the import.

**Leaving `org-hierarchy.js` unmocked** sends cross-org fixtures at real Mongoose:
~3 s, then a 500.

**Mock registration order is load order.** `jest.requireActual` on a local module
pulls that module's whole graph *now*. If it validates config at import, register
the `config.js` mock **before** the `requireActual`.

**A spy that reads the value it is about to fake.**
`jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000)` in a
`beforeEach` only advances the clock because the *previous* test's spy was still
installed when `Date.now()` was read. Under `restoreMocks` it reads the real
clock every time and the fake clock freezes. Hold the fake value in a variable
and advance it explicitly.
