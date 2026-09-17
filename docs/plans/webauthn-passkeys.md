# Passkeys (WebAuthn) — Implementation Plan

Status: **READY TO BUILD — no code yet** (2026-09-17). Forward-only, fresh-install; no compat shims.
Libraries: `@simplewebauthn/server@14.0.2`, `@simplewebauthn/browser@14.0.0` (dual CJS/ESM, Node ≥ 20).
Phase 1 is self-contained and shippable; Phase 2 is a separate change.

---

## 0. Why

`requireStepUp` gates ~30 destructive routes. The only way to obtain a step-up token is
`POST /auth/step-up` with a password, and `User.comparePassword` returns `false` when
`password` is unset. **Users provisioned through OAuth or SSO can never pass step-up.**
Passkey step-up issues the same step-up JWT, so `requireStepUp` and the 17 `StepUpModal`
call sites stay unchanged.

## 1. Decisions (locked)

| # | Decision |
|---|---|
| D1 | **RP ID** = exact hostname of `PLATFORM_FRONTEND_URL` (local/minikube → `localhost`; AWS → `<DOMAIN>`), not the parent domain. Origins keep the port. Optional overrides `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` / `WEBAUTHN_RP_NAME`. **Fail boot** if the RP ID is an IP, an origin host is not the RP ID or a subdomain of it, or an origin is non-https (except `http://localhost`). Changing the RP ID orphans every passkey. |
| D2 | **Orgs that require SSO:** passkey login BLOCKED (`rejectIfSsoEnforced`); passkey step-up and registration ALLOWED. |
| D3 | **First-passkey bootstrap:** a user with no password AND no passkey may register within `WEBAUTHN_BOOTSTRAP_WINDOW_SEC` (600) of primary authentication. Everyone else needs a step-up token. **Refinement:** `authTime` is stored on the server-side **refresh-session slot** (`User.refreshSessions[].authTime`, looked up by the token's `sid`), not in a JWT claim. The slot survives refresh (`renewSessionTokens` only `$set`s `hash`/`lastUsedAt`) and switch-org. PATs and impersonation tokens have no `sid`, so they are ineligible automatically. Slots without `authTime` are ineligible (no fallback). |
| D4 | Ceremony settings: `attestationType: 'none'`, `residentKey: 'required'`, `userVerification: 'required'` everywhere, library-default algorithms (v14: EdDSA, ES256, RS256), 5-min challenge TTL, `excludeCredentials` on register. Counter check: reject + audit `user.webauthn.clone_suspected` when stored > 0 and new ≤ stored. |

---

## 2. Phase 1 — Registration, management, passkey step-up

Tasks run in order; each lists files, the change, and done-criteria. Size: S < ½ day, M ≈ 1 day, L ≈ 2 days.

### T1. Dependencies (S)
- `.projenrc.ts`:
  - platform `deps` += `'@simplewebauthn/server@14.0.2'`
  - frontend `deps` += `'@simplewebauthn/browser@14.0.0'`
- `npx projen` → `pnpm install`. Both are ≥ 24h old, so they pass `minimumReleaseAge: 1440`.
- **Done:** `pnpm nx run-many -t build --projects=platform,frontend` is green. Verify `package.json` versions after the projen regen.

### T2. Config + boot validation (S)
- `platform/src/config/index.ts`: add `auth.webauthn = { rpID, rpName, origins[], bootstrapWindowSec, challengeTtlMs }`, derived from `PLATFORM_FRONTEND_URL` unless overridden.
- New `platform/src/config/webauthn-validate.ts`: `assertWebAuthnConfig(cfg)` throws for the D1 violations. Call it at config load.
- **Tests** (`platform/test/webauthn-config.test.ts`):
  - defaults derive from the URL (port kept in origin, not in RP ID)
  - an IP RP ID throws
  - a mismatched origin throws
  - `http://localhost` is allowed; `http://example.com` throws
  - a subdomain origin under the RP ID is allowed

### T3. Data model (S)
- New `platform/src/models/webauthn-credential.ts`:
  - fields `userId` (idx), `credentialId` (unique), `publicKey: Buffer`, `counter`, `transports[]`, `deviceType`, `backedUp`, `aaguid`, `name` (≤64), `createdAt`, `lastUsedAt`
  - export from `models/index.ts`
- `platform/src/models/user.ts`:
  - `webauthnUserId?: string` (`select: false`, unique sparse index)
  - `RefreshSession.authTime?: Date` (interface + subdocument schema)
- `platform/src/services/user-cascade.ts`: `WebAuthnCredential.deleteMany({ userId }, { session })` next to the PAT delete.
- **Tests:** extend the user-cascade test to assert credentials are removed.

### T4. `authTime` on session slots (M)
- `platform/src/utils/token.ts`:
  - `issueTokens(user, activeOrgId?, expiresIn?, scope?, opts?: { authTime?: Date })` writes `authTime` into the pushed slot only when given.
  - `renewSessionTokens` stays as-is (the `$set` already preserves the field). Add a comment saying it must not reset `authTime`.
- Pass `authTime: new Date()` only at primary auth:
  - `controllers/auth.ts` `login`
  - `controllers/oauth.ts` callback (~L460)
  - `controllers/sso.ts` callback (~L129)
- **Do not** pass it from `controllers/user-profile.ts`:
  - `createToken` (~L259) mints API tokens without re-authenticating
  - `revokeAllTokens` (~L399) should copy the **caller's** slot `authTime`, so signing out everywhere doesn't reset the window
- `controllers/auth.ts` `switchOrg`: the no-`sid` branch (PAT) passes nothing.
- New helper `platform/src/helpers/session-auth-time.ts`: `getSessionAuthTime(userId, sid): Promise<Date | null>`.
- **Tests** (`platform/test/session-auth-time.test.ts`):
  - login, OAuth and SSO set it
  - refresh and switch-org preserve it
  - `/user/token` slot has none
  - revoke-all carries the caller's value

### T5. Step-up token carries its method (S)
- `packages/api-core/src/middleware/step-up.ts`: `StepUpTokenPayload.method?: 'password' | 'webauthn'`.
- `platform/src/utils/token.ts`: `issueStepUpToken(userId, method, ttlSeconds = 60)`. Update the call in `controllers/step-up.ts` with `'password'`.
- `controllers/step-up.ts`: add `details.method: 'password'` to the failure audit.
- **Done:** api-core and platform builds are green, and the existing step-up tests still pass.

### T6. Shared limiter + session guard (S)
- `routes/auth.ts`: move `stepUpLimiter` into `platform/src/middleware/step-up-limiter.ts` so password and passkey step-up **share one budget** (Redis prefix `platform:step-up` unchanged).
- New `platform/src/middleware/require-interactive-session.ts`: rejects `403 INTERACTIVE_SESSION_REQUIRED` when `!req.user.sid`, `req.user.impersonatorId`, or `req.user.scope`. Export it from `middleware/index.ts`.
- **Tests:** PAT, impersonation and scoped tokens are rejected; a normal session passes.

### T7. WebAuthn service (L)
New `platform/src/services/webauthn-service.ts`. It holds everything that touches SimpleWebAuthn; controllers stay thin.

- **Challenge stores** (`createPendingStateStore`, TTL `challengeTtlMs`): `webauthn:reg` and `webauthn:stepup` → `{ userId, challenge }`, keyed by a random `ceremonyId` (32 bytes base64url).
- `ensureWebAuthnUserId(userId)`: lazily set 32 random bytes; atomic `findOneAndUpdate` with `webauthnUserId: { $exists: false }`, then re-read.
- `registrationOptions(user)`:
  - `generateRegistrationOptions({ rpName, rpID, userName: email, userDisplayName: username, userID, excludeCredentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestationType: 'none' })`
  - store the challenge; return `{ ceremonyId, options }`
- `verifyRegistration(userId, ceremonyId, response, name)`:
  - consume the challenge and require `entry.userId === userId`
  - `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true })`
  - save from `registrationInfo.credential` (`id`, `publicKey`, `counter`, `transports`), `credentialDeviceType`, `credentialBackedUp`, `aaguid`
  - a duplicate `credentialId` → `409 CREDENTIAL_EXISTS`
- `stepUpOptions(userId)`: `generateAuthenticationOptions({ rpID, allowCredentials, userVerification: 'required' })`; no credentials → `NO_PASSKEYS`.
- `verifyAssertion(expectedUserId | null, ceremonyEntry, response)` (shared with Phase 2):
  - look up by `response.id`
  - require the credential's owner to match `expectedUserId`
  - `verifyAuthenticationResponse({ …, credential: { id, publicKey, counter, transports }, requireUserVerification: true })`
  - counter policy (D4)
  - `$set` `counter` + `lastUsedAt`
- `list(userId)` (no `publicKey`), `rename(userId, id, name)`, `remove(userId, id)`:
  - the last-method guard: no password AND no `oauth` link AND count == 1 → `LAST_SIGN_IN_METHOD`
  - owner-scoped queries only
- Errors: string sentinels mapped by the controller's `errorMap`, matching the existing `withController` pattern.
- **Tests** (`platform/test/webauthn-service.test.ts`, `verify*Response` mocked):
  - challenge is consume-once, and a mismatched-user challenge is rejected
  - `excludeCredentials` is populated
  - duplicate credential → 409
  - counter regression rejected + audited; counter 0/0 accepted
  - credential owned by another user → rejected
  - last-method guard in all combinations
  - `webauthnUserId` is created once under concurrency

### T8. Controllers + routes (M)
- New `platform/src/controllers/webauthn.ts` and `platform/src/routes/webauthn.ts`, mounted in `routes/auth.ts` with `router.use('/webauthn', webauthnRoutes)`. They inherit `/auth` and `authLimiter`.

| Route | Middleware chain |
|---|---|
| `POST /register/options` | `requireAuth, requireInteractiveSession, requireStepUpOrBootstrap` |
| `POST /register/verify` | `requireAuth, requireInteractiveSession` |
| `GET /credentials` | `requireAuth` |
| `PATCH /credentials/:id` | `requireAuth, requireInteractiveSession` |
| `DELETE /credentials/:id` | `requireAuth, requireInteractiveSession, requireStepUp` |
| `POST /step-up/options` | `requireAuth, stepUpLimiter` |
| `POST /step-up/verify` | `requireAuth, stepUpLimiter` → `issueStepUpToken(userId, 'webauthn')` |

- `requireStepUpOrBootstrap` (in the controller file):
  - user has a password or ≥1 passkey → delegate to `requireStepUp`
  - otherwise require `getSessionAuthTime(sub, sid)` within `bootstrapWindowSec`, else `401 REAUTH_REQUIRED`
- Validation: zod schemas for `{ ceremonyId, response, name? }`. Use the library's JSON response types.
- **Audit:**
  - add `user.webauthn.registered`, `user.webauthn.renamed`, `user.webauthn.removed`, `user.webauthn.clone_suspected` to `ALL_AUDIT_ACTIONS` in `models/audit-event.ts`
  - step-up failure → `user.login.failed` with `details.method: 'webauthn'`
  - check `test/audit-remote-subset.test.ts` / `mock-parity.test.ts` still pass
- **Metrics:** `incCounter('platform_webauthn_ceremonies_total', { type: 'register'|'stepup', outcome: 'success'|'failure' })`.
- **Tests** (`platform/test/webauthn-routes.test.ts`, supertest):
  - the middleware chain for each route
  - bootstrap window: inside / outside / missing `authTime` / user with a password is forced to step up
  - SSO-enforced user can register and step up (D2)
  - impersonation token blocked on register
  - the step-up token from passkey verify satisfies `requireStepUp` on `DELETE /user/account`

### T9. Profile flags (S)
- `services/user-profile-service.ts` `getProfileWithOrgs`:
  - compute `hasPassword` with `User.exists({ _id, password: { $exists: true, $ne: null } })`, never selecting the hash
  - compute `hasPasskeys` with `WebAuthnCredential.exists({ userId })`
- `controllers/user-profile.ts` `formatUserResponse`: include both.
- `frontend/src/types/index.ts` `User`: `hasPassword?: boolean; hasPasskeys?: boolean`.
- **Tests:** a profile test covers an OAuth-only user → `hasPassword: false`.

### T10. Frontend API (S)
- `frontend/src/lib/api/domains/auth.ts`:
  - `listPasskeys`, `renamePasskey`, `deletePasskey(id, stepUpToken)`
  - `registerPasskey(name, stepUpToken?)`: options → `startRegistration({ optionsJSON })` → verify
  - `stepUpWithPasskey()`: options → `startAuthentication({ optionsJSON })` → verify → `{ stepUpToken }`
- New `frontend/src/lib/webauthn-errors.ts`:
  - `NotAllowedError` / `AbortError` → `null` (silent)
  - `InvalidStateError` → "This passkey is already registered"
  - `SecurityError` → "Passkeys aren't available on this domain"
  - `REAUTH_REQUIRED` → "Sign in again to add your first passkey"

### T11. StepUpModal (M)
- `frontend/src/components/admin/StepUpModal.tsx`:
  - read `hasPassword`/`hasPasskeys` from `useAuth().user`
  - passkeys → primary "Use passkey" button (`stepUpWithPasskey`)
  - password → the existing form (secondary when passkeys also exist)
  - neither → explanation + link to `/dashboard/settings?tab=security#passkeys`
  - props and the `onConfirmed(stepUpToken)` contract are unchanged
  - title becomes "Confirm it's you"
- **Tests** (`frontend/test/step-up-modal-passkey.test.tsx`, `@simplewebauthn/browser` mocked):
  - each of the three user states renders correctly
  - cancel is silent
  - success calls `onConfirmed`
  - existing `ai-provider-config-stepup.test.tsx` still passes

### T12. PasskeySection (M)
- New `frontend/src/components/settings/PasskeySection.tsx` (a `SectionCard` matching `PatSection`):
  - list with name, created, last used, synced badge (`backedUp`)
  - add (name prompt; opens `StepUpModal` first unless in the bootstrap case, then retries on `REAUTH_REQUIRED` messaging)
  - rename inline; remove via `StepUpModal`
  - `LAST_SIGN_IN_METHOD` shown as an explanatory error
  - hidden when `!browserSupportsWebAuthn()`
  - `readOnly` prop for impersonation, like `PatSection`
- **Placement:** `frontend/pages/dashboard/settings.tsx`, **Security** tab, directly below the Password `FormSection`. Render `<PasskeySection readOnly={isReadOnly} />` inside a wrapper with `id="passkeys"`.
  - Passkeys are a sign-in credential, so they sit beside change-password, not beside API tokens.
  - Deep link: `/dashboard/settings?tab=security#passkeys` (the tab is already URL-driven via `useUrlTab`).
  - The Security tab's existing `ReadOnlyNotice` already covers impersonation.
  - `tokens.tsx` is unchanged.
- **No MFA on/off checkbox in Phase 1.** Until login becomes two steps (Phase 3, P3-T1), such a flag would change nothing. A passkey is simply an extra credential that `StepUpModal` offers when present.
- **Tests:**
  - list/add/remove happy paths, the last-method error, read-only hides actions
  - `?tab=security#passkeys` renders the section
  - no MFA toggle is rendered

### T13. Headers, env, docs (S)
- `Permissions-Policy` += `publickey-credentials-get=(self), publickey-credentials-create=(self)` in:
  - `deploy/local/docker/nginx/nginx.conf`
  - `deploy/local/minikube/nginx/nginx.conf`
  - `deploy/aws/ec2/nginx/nginx.conf`
  - `deploy/aws/eks/nginx/nginx.conf`
  - `frontend/next.config.js`
- The four `.env.example` files: commented-out `WEBAUTHN_*` overrides with the RP-ID-is-permanent warning. Run `platform/test/deploy-env-contract.test.ts`.
- Docs:
  - `docs/environment-variables.md` (+ `node frontend/scripts/generate-help.mjs`)
  - `docs/authentication.md` (new Passkeys section: D1–D3 in user terms)
  - `docs/api-reference.md` (7 routes)
  - `docs/audit-events.md` (4 actions + `details.method`)
  - `frontend/src/lib/help/whats-new.ts`

### T14. E2E smoke + gate (M)
- Manual or scripted smoke against local docker with Chrome's virtual authenticator (CDP `WebAuthn.enable` + `addVirtualAuthenticator { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true }`). Flow:
  - OAuth-only user → add passkey (bootstrap)
  - delete-account step-up via passkey succeeds
  - password user → add passkey requires a step-up token
  - remove the last passkey on an OAuth-less, password-less account → refused
- Also confirm `localhost` ceremonies work behind the self-signed cert (the D1 dev assumption).
- **Gate:** `pnpm nx run-many -t build --all`, then `pnpm nx run-many -t test --all`.

**Phase 1 order and dependencies:**

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14
                  └──────── T4/T5/T6 are independent of each other ────────┘
```

---

## 3. Phase 2 — Passwordless login (separate change)

### P2-T1. Service + routes (M)
- `webauthn-service.ts`: challenge store `webauthn:login` → `{ challenge }`. Add `loginOptions()` (`allowCredentials: []`, `userVerification: 'required'`).
- `loginVerify(ceremonyId, response)`:
  - `verifyAssertion(null, …)`
  - assert `response.response.userHandle === user.webauthnUserId`
- Routes: public `POST /auth/webauthn/login/options` and `POST /auth/webauthn/login/verify`.
- **Rate limit (resolve first):** autofill requests options on every sign-in page load, which would burn the IP-keyed `authLimiter` (shared NAT). Mount `login/options` with its own higher Redis limiter (`platform:webauthn-login-options`); keep `login/verify` under `authLimiter`.
- Controller order:
  1. verify
  2. `rejectIfSsoEnforced(res, user.email)` (D2)
  3. `issueTokens(user, user.lastActiveOrgId, undefined, undefined, { authTime: new Date() })`
  4. audit `user.login` with `details.method: 'webauthn'`
  5. `incCounter('platform_logins_total')`
- Every failure returns the same `401 Invalid credentials` plus `user.login.failed { method: 'webauthn', reason }` and `platform_logins_failed_total`.
- **Tests:** userHandle mismatch, unknown credential, SSO-enforced refusal, counter regression, a successful login creates a slot with `authTime`, the options limiter is separate from `authLimiter`.

### P2-T2. Frontend (M)
- `frontend/src/hooks/useAuth.tsx`: `loginWithPasskey({ autofill?: boolean })`. It shares post-login handling with `login` (applyTokens, redirect, onboarding gate).
- `frontend/src/components/landing/LandingPage.tsx`:
  - identifier input `autoComplete="username webauthn"`
  - on mount, when `browserSupportsWebAuthnAutofill()`, start `loginWithPasskey({ autofill: true })`
  - a "Sign in with passkey" button (the library's abort service cancels the pending autofill request)
  - `SSO_REQUIRED` → the existing SSO redirect messaging
- **Tests:** autofill starts only when supported, the button path, the SSO_REQUIRED path, cancel is silent.

### P2-T3. Docs + gate (S)
- Update `docs/authentication.md`, `docs/api-reference.md`, `whats-new`. Virtual-authenticator login smoke. Build + test gate.

---

## 4. Phase 3 — Deferred (needs its own design)

### P3-T1. Guarded "Require passkey at sign-in" setting (L)
This replaces a plain MFA checkbox. It only exists once login is two steps: password → partial token → passkey → full tokens. That two-step login is designed in the same change.

**Backend**
- `User.mfaRequired: boolean` (default `false`, `select: false`). This is the only stored flag; the UI never writes it directly.
- `POST /api/user/mfa/enable`
  - `requireAuth`, `requirePrincipalType('user')`, not impersonated, `requireStepUp` with a **passkey** step-up
  - refuses `409 MFA_NO_PASSKEY` when the user has 0 passkeys
- `POST /api/user/mfa/disable`
  - same chain, but the step-up token must carry `method: 'webauthn'`; a password step-up → `403 STEP_UP_METHOD_INSUFFICIENT`, so a stolen password alone can't remove MFA
  - refuses `409 MFA_ORG_ENFORCED` when any org the user belongs to enforces MFA for their role
- `DELETE /auth/webauthn/credentials/:id`: when `mfaRequired` (or org-enforced) and this is the last passkey → `409 MFA_LAST_PASSKEY` (on top of T7's `LAST_SIGN_IN_METHOD`).
- Effective MFA = `user.mfaRequired || orgRequiresMfa(user, role)`. The org half comes from the "require MFA for admins" org setting (improvement #6, separate task). The effective value drives the two-step login and is returned by the profile as `mfa: { required, enforcedByOrg }`.
- Audit `user.mfa.enabled` / `user.mfa.disabled` (with `details.stepUpMethod`); add both to `ALL_AUDIT_ACTIONS`. Bump `tokenVersion` on disable so existing sessions have to sign in again under the new policy.
- Service accounts and services: endpoints return `403 PRINCIPAL_NOT_ALLOWED`; the flag is meaningless for them.

**Frontend**
- `PasskeySection` (Settings → Security) gains a **"Require passkey at sign-in"** control. It is not a free checkbox:
  - disabled with the hint "Add a passkey first" when `hasPasskeys` is false
  - toggling on or off opens `StepUpModal`, offering passkey only for disable
  - shown locked on with "Required by <org>" when `mfa.enforcedByOrg`
  - hidden for read-only (impersonation) sessions
- Removing the last passkey while MFA is required shows the `MFA_LAST_PASSKEY` explanation instead of the remove action.

**Tests**
- enable refused with 0 passkeys
- disable refused with a password step-up; allowed with a passkey step-up
- disable refused when org-enforced
- last-passkey delete refused under MFA
- audit + `tokenVersion` bump on disable
- UI states: no passkeys / off / on / org-locked / read-only

### Other Phase 3 items
- Org policy: require MFA for admins (improvement #6); feeds `orgRequiresMfa` above.
- Org policy: require passkey for step-up (Team+ capability candidate).
- Org policy: allow passkey login alongside SSO (relaxes D2).
- AAGUID allowlist / attestation verification (enterprise).
- Recovery for passkey-only or MFA-required accounts.

---

## 5. Risks & checks

| Risk | Mitigation |
|---|---|
| RP ID set wrong in a deploy orphans passkeys later | D1 boot validation; `.env.example` warning; derived default |
| Redis down means challenge falls back to the local Map, so ceremonies fail across replicas | Same accepted trade-off as OAuth state; the user retries |
| v14 API drift from older examples | Signatures checked against the 14.0.2 typings: `verifyAuthenticationResponse` requires `expectedRPID` + `credential: { id, publicKey, counter, transports }`; registration output is `registrationInfo.credential` |
| An impersonator or stolen PAT registers a persistent credential | `requireInteractiveSession`; bootstrap requires slot `authTime`, which API tokens never get |
| Signing out everywhere or minting API tokens reopens the bootstrap window | T4: `createToken` sets no `authTime`; revoke-all copies the caller's |
| Autofill exhausts the shared IP auth limiter | P2-T1 separate options limiter |
| An MFA toggle locks the user out or is removable with only a password | No plain checkbox; P3-T1 requires a passkey to enable, passkey step-up to disable, and blocks last-passkey removal while MFA is on |
