---
layout: default
title: Authentication & SSO
image: /assets/og-image-solution.png
---

# Authentication & SSO

Pipeline Builder supports four ways to sign in, side by side:

1. **Email + password** — the always-on baseline (JWT sessions, short-TTL
   access tokens + `tokenVersion` invalidation; see [Roles & Permissions](permissions.md)).
2. **OAuth social login** — platform-wide "Sign in with…" buttons for Google,
   GitHub, Facebook, Microsoft, GitLab, and LinkedIn. Configured once per
   deployment through environment variables; each provider appears only when its
   credentials are set.
3. **Per-org enterprise SSO (OIDC or SAML 2.0)** — an organization brings its own
   identity provider (Okta, Microsoft Entra ID, AWS Cognito, Auth0, Keycloak,
   Shibboleth, …). Configured per-org in the app, not by env, and gated on the
   `sso` entitlement. Both protocols end at the same verified identity and pass
   the same checks; see [SAML 2.0](#saml-20).
4. **Passkeys (WebAuthn)** — the device itself (fingerprint, face, screen lock,
   or a security key). Nothing to configure: a person adds one from
   Security → Factors and it works from then on. See [Passkeys](#passkeys-webauthn).

On top of the first of those sits one **second factor**:

5. **Authenticator app (TOTP)** — a 6-digit code from a phone, asked for after
   the password. Also configured by the person from Security → Factors. See
   [Authenticator app](#authenticator-app-totp).

The first two are **global**: one app registration per provider, shared by
every organization on the deployment. The third is **per-organization**: each
org registers its own IdP and can force its users through it. The last two are
**per-person**: a passkey and a TOTP enrolment belong to the account, not to the
deployment.

The CLI does not add a fourth way: `pipeline-manager auth login` hands the
sign-in to a browser through the **device authorization grant**, so it inherits
whichever of the three the account uses — see
[CLI sign-in by device authorization](#cli-sign-in-by-device-authorization-rfc-8628).

---

## OAuth social login (platform-wide)

Social login is enabled per provider by setting that provider's client
credentials as environment variables on the **platform** service. A provider is
**enabled if and only if its `OAUTH_<P>_CLIENT_ID` is set** — the behavior is
**fail-soft**: an unconfigured provider is simply hidden, never an error. The
login page fetches the enabled set (`GET /api/auth/oauth/providers`) and renders
its buttons **data-driven**, so a "Sign in with GitLab" button appears the
moment GitLab credentials are present and disappears when they're removed.

Credentials are **global / platform-wide** — one app registration per provider
covers the whole deployment. There is no per-org social-login registration.

The buttons are hidden for anyone whose email domain is
[federated](#signing-in-with-sso): social login is one of the bypasses the
backend refuses for a covered account, so the card offers that org's SSO instead.

### Supported providers

| Provider | Env vars | Register an app at |
|----------|----------|--------------------|
| **Google** | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET` | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth 2.0 Client ID |
| **GitHub** | `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers) |
| **Facebook** | `OAUTH_FACEBOOK_CLIENT_ID`, `OAUTH_FACEBOOK_CLIENT_SECRET` | [Meta for Developers](https://developers.facebook.com/apps) → Facebook Login |
| **Microsoft** | `OAUTH_MICROSOFT_CLIENT_ID`, `OAUTH_MICROSOFT_CLIENT_SECRET`, `OAUTH_MICROSOFT_TENANT` | [Microsoft Entra admin center](https://entra.microsoft.com) → App registrations |
| **GitLab** | `OAUTH_GITLAB_CLIENT_ID`, `OAUTH_GITLAB_CLIENT_SECRET`, `OAUTH_GITLAB_BASE_URL` | GitLab → User Settings → [Applications](https://gitlab.com/-/profile/applications) (or your self-hosted instance) |
| **LinkedIn** | `OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET` | [LinkedIn Developers](https://www.linkedin.com/developers/apps) → "Sign in with LinkedIn using OpenID Connect" |

Shared across all providers:

| Variable | Default | Description |
|----------|---------|-------------|
| `OAUTH_CALLBACK_BASE_URL` | `${PLATFORM_FRONTEND_URL}` | Origin the provider redirects back to. Each handler appends `/auth/callback/<provider>` (e.g. `/auth/callback/microsoft`). Register this exact callback URL in the provider's console. |
| `OAUTH_STATE_TTL_MS` | `600000` | CSRF `state` token TTL (10 min). |
| `OAUTH_CLEANUP_INTERVAL_MS` | `60000` | Stale-state cleanup interval. |

**Provider-specific notes:**

- **Microsoft** (Entra / Azure AD v2, OIDC) — `OAUTH_MICROSOFT_TENANT` scopes the
  authority and defaults to `common` (any organizational or personal account);
  set it to a specific tenant id or domain to restrict to one directory. The
  tenant is interpolated into the authorize/token URLs; userinfo is the
  tenant-agnostic Microsoft Graph endpoint.
- **GitLab** (OIDC) — `OAUTH_GITLAB_BASE_URL` defaults to `https://gitlab.com`;
  point it at a self-hosted GitLab instance to authenticate against that. The
  email must be verified (`email_verified === true`).
- **LinkedIn** — uses "Sign in with LinkedIn using OpenID Connect"; email is
  taken from the OIDC `email` claim.

### Registering the callback URL

Whatever `OAUTH_CALLBACK_BASE_URL` resolves to, the redirect URI you register in
each provider's developer console is:

```
<OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>
```

for example `https://ci.acme.com/auth/callback/google`. A mismatch here is the
most common cause of a failed social login.

### Per-provider setup walkthroughs

Each walkthrough registers **one platform-wide app** in the provider's console,
sets the redirect URI to `<OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>`,
and copies the resulting client ID/secret into the env vars below. The scopes
listed are the ones the platform requests automatically — you generally don't
declare them in the console (Google, Microsoft, GitLab, and LinkedIn surface a
consent screen; GitHub and Facebook request scopes at authorize time). Replace
`<base>` with whatever `OAUTH_CALLBACK_BASE_URL` resolves to.

#### Google

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → pick/create a project.
2. **OAuth consent screen** (first time only): User type **External**, set app name + support email, add scopes `openid`, `email`, `profile`. While the screen is in **Testing** only listed test users can sign in — **Publish** it to allow anyone.
3. **Credentials → Create Credentials → OAuth client ID → Web application**.
4. **Authorized redirect URIs** → add `<base>/auth/callback/google`.
5. Copy the Client ID/secret → `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`.

Requested scopes: `openid email profile`. The account's `email_verified` must be true.

```bash
OAUTH_GOOGLE_CLIENT_ID=your-client-id
OAUTH_GOOGLE_CLIENT_SECRET=your-client-secret
```

#### GitHub

1. GitHub → Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers) → **New OAuth App**.
2. **Homepage URL** = your frontend URL; **Authorization callback URL** = `<base>/auth/callback/github`.
3. **Generate a new client secret**, then copy both → `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`.

Requested scopes: `read:user user:email` (OAuth Apps don't pre-declare scopes). The platform reads the primary **verified** email via `/user/emails`, so a user with no verified email can't sign in.

```bash
OAUTH_GITHUB_CLIENT_ID=your-client-id
OAUTH_GITHUB_CLIENT_SECRET=your-client-secret
```

#### Facebook

1. [Meta for Developers](https://developers.facebook.com/apps) → **Create App** (use case: **Authenticate and request data from users with Facebook Login**) → add the **Facebook Login** product (Web).
2. **Facebook Login → Settings → Valid OAuth Redirect URIs** → add `<base>/auth/callback/facebook`.
3. **App settings → Basic**: App ID → `OAUTH_FACEBOOK_CLIENT_ID`, App Secret → `OAUTH_FACEBOOK_CLIENT_SECRET`.
4. Switch the app from **Development** to **Live** so non-admin users can log in. The `email` permission is granted by default for login, but going live for a broad audience may require Meta **App Review** / Advanced Access for `email`.

Requested scopes: `email,public_profile`. Facebook is OAuth2 (not OIDC); if the user declines `email` the login **fails** because no account email is returned.

```bash
OAUTH_FACEBOOK_CLIENT_ID=your-app-id
OAUTH_FACEBOOK_CLIENT_SECRET=your-app-secret
```

#### Microsoft (Entra / Azure AD)

1. [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations → New registration**.
2. **Supported account types** decides who can sign in and maps to `OAUTH_MICROSOFT_TENANT`: *any org + personal* → `common`; *single directory* → that tenant's ID/domain.
3. **Redirect URI** → platform **Web** → `<base>/auth/callback/microsoft`.
4. **Certificates & secrets → New client secret** → copy the **Value** (not the ID) → `OAUTH_MICROSOFT_CLIENT_SECRET`. **Overview → Application (client) ID** → `OAUTH_MICROSOFT_CLIENT_ID`. Set `OAUTH_MICROSOFT_TENANT` (`common` unless you scoped to one directory).

Requested scopes: `openid email profile`.

```bash
OAUTH_MICROSOFT_CLIENT_ID=your-application-client-id
OAUTH_MICROSOFT_CLIENT_SECRET=your-client-secret-value
OAUTH_MICROSOFT_TENANT=common
```

#### GitLab

1. GitLab → User Settings → [Applications](https://gitlab.com/-/profile/applications) (or `<your-instance>/-/profile/applications`) → **Add new application**.
2. **Redirect URI** → `<base>/auth/callback/gitlab`; check scopes `openid`, `email`, `profile`; keep **Confidential** enabled.
3. Copy **Application ID** → `OAUTH_GITLAB_CLIENT_ID`, **Secret** → `OAUTH_GITLAB_CLIENT_SECRET`. For a self-hosted instance also set `OAUTH_GITLAB_BASE_URL` to its origin.

Requested scopes: `openid email profile`. The GitLab email must be verified.

```bash
OAUTH_GITLAB_CLIENT_ID=your-application-id
OAUTH_GITLAB_CLIENT_SECRET=your-secret
# Self-hosted GitLab only (defaults to https://gitlab.com):
OAUTH_GITLAB_BASE_URL=https://gitlab.example.com
```

#### LinkedIn

1. [LinkedIn Developers](https://www.linkedin.com/developers/apps) → **Create app** (requires an associated LinkedIn **Company Page**).
2. **Products** tab → request **"Sign in with LinkedIn using OpenID Connect"**.
3. **Auth** tab → **Authorized redirect URLs for your app** → add `<base>/auth/callback/linkedin`. Copy the Client ID/secret → `OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`.

Requested scopes: `openid email profile`.

```bash
OAUTH_LINKEDIN_CLIENT_ID=your-client-id
OAUTH_LINKEDIN_CLIENT_SECRET=your-client-secret
```

### Apply and verify

1. Set the provider's `OAUTH_<P>_CLIENT_ID` / `_CLIENT_SECRET` (and any provider-specific var) on the **platform** service, plus `OAUTH_CALLBACK_BASE_URL` if it isn't already your public frontend origin.
2. Restart/redeploy the platform service.
3. Confirm the provider is live: `curl <PLATFORM_BASE_URL>/api/auth/oauth/providers` lists it, and a matching **"Sign in with …"** button appears on the login page.
4. Click it end-to-end. A redirect-URI mismatch is by far the most common failure — the URI in the console must equal `<base>/auth/callback/<provider>` exactly (scheme, host, and path).

### What happens on first sign-in (account + org creation)

Social login and social **sign-up are the same flow** — there is no separate
OAuth registration endpoint. The callback verifies the provider identity, then
resolves it in three cases (`authService.findOrCreateOAuthUser`):

1. **Returning identity** — a user already linked to this provider's account id → straight login, nothing created.
2. **Email already registered** — a user with the same (provider-verified) email exists → the provider is **linked to that existing account** and they're logged in. This is how signing in with, say, Facebook later attaches to the account first created with Google under the same email — **no second organization is created**. **Hardening:** the silent link happens only when the pre-existing account's **own email is verified** (`isEmailVerified`). Linking into an *unverified* account is refused with a `409` (`ACCOUNT_EMAIL_UNVERIFIED`) — this closes the vector where someone plants an unverified password account on a victim's address and gets the victim signed into it on their first social login. The user verifies (or resets the password on) that account first, then links.
3. **Brand-new identity → auto-provision.** A new `User` is created (marked email-verified, since the provider verified it) and flagged `needsOnboarding`, and in a single transaction the platform also creates:
   - a **personal organization**, initially **named after the derived username** (from the provider's display name, else the email local-part — lowercased, stripped to `[a-z0-9_-]`, length-capped, and made unique);
   - an **owner** membership for the new user;
   - the default **Admin/Member roles** — identical to what email registration seeds.

**First-run onboarding.** Because a social signup collected no org name or plan,
a brand-new user is flagged `needsOnboarding` and the app's auth guard routes
them to a one-time **"Name your organization"** screen (`/dashboard/onboarding`)
before the dashboard. There they rename the auto-created org and — when billing
is enabled — pick a plan; `POST /auth/onboarding/complete` renames the org
(reusing the identity-rename path), provisions the plan (fire-and-forget,
mirroring register), and clears the flag. "Skip for now" keeps the derived name
and clears the flag. Email/password registrants and SSO-provisioned users are
**not** flagged (they already supplied an org name or belong to an enforced org).

A few consequences worth knowing:

- **Tier.** The new org takes the default quota tier and is **not** provisioned to
  a paid tier until billing does so (no free paid-tier grant). When billing is
  off, the onboarding plan step is hidden and any `planId` is inert.
- **Facebook needs email.** Facebook only returns an email if the user grants the
  `email` scope; if they decline, sign-in fails with `OAUTH_NO_EMAIL` and **no
  account or org is created**.
- **SSO enforcement still applies.** If the email's domain is covered by an
  enabled, `sso`-entitled org IdP, the social grant is rejected with
  `SSO_REQUIRED` (see [enforcement](#per-org-enterprise-sso)) rather than
  creating a personal org — the user is routed through their org's IdP instead.

### PKCE on every authorization-code flow

Every authorization-code flow the platform starts — social sign-in, per-org SSO,
and the step-up provider re-auth that shares their helpers — is protected with
**PKCE (RFC 7636)**, always with `S256`.

- The initiate leg mints a fresh 43-character `code_verifier` and sends only its
  SHA-256 `code_challenge` in the redirect. **The verifier never leaves the
  server** and never reaches the browser: it is stored with the single-use
  pending `state` in the shared Redis, so it is cross-replica, dies with that
  state, and is usable exactly once.
- The token exchange presents the verifier. A leaked or intercepted
  authorization code is therefore worthless to anyone else — the provider
  re-derives the challenge and refuses a code redeemed with the wrong verifier.
- **No downgrade.** `plain` is never offered or accepted. For per-org SSO the
  issuer's `code_challenge_methods_supported` is honoured: `S256` when it is
  advertised, `S256` anyway when the document omits the field (advertising is
  optional and an unknown authorization parameter is ignored), and **no PKCE at
  all** for an issuer that advertises only `plain`. Once a challenge has gone
  out, an exchange without its verifier is refused rather than retried
  unprotected.
- **Per-provider support** is taken from each provider's current documentation:
  Google, Microsoft Entra, GitLab, GitHub (OAuth Apps, since July 2025) and
  generic OIDC issuers get PKCE. **LinkedIn** does not — its PKCE flow must be
  enabled per app by LinkedIn and uses a different authorization endpoint, and
  it does not ignore the extra parameters. **Facebook** does not — Meta
  documents `code_challenge` only for its separate OIDC code flow, not the
  Graph-API flow used here. Those two keep `state` as their CSRF protection;
  nothing else about them changes.

> **Cutover:** there is no compatibility path. Any sign-in, SSO login or step-up
> re-auth that is mid-flight when the new build rolls out fails with an
> invalid-state error; the user retries and gets a PKCE-protected flow. Nothing
> needs to be configured, and no identity-provider settings change.

### Providers reachable via generic OIDC

**Apple, X (Twitter), Amazon, Discord, and Slack** are **not** named social-login
buttons today. Where they are OIDC-compliant they can be wired up as a per-org
enterprise SSO provider through **generic OIDC** (below). Apple is not a native button: it needs an ES256
signed-JWT client secret and a `form_post` callback, so it does not fit the
standard OAuth handler.

---

## Per-org enterprise SSO

An organization can register its **own** identity provider so its users sign in
through corporate SSO instead of a password. This is configured **per
organization inside the app** — never through environment variables — and is
stored as an `OrgIdpConfig` (one config per org).

One config, one protocol: `protocol` selects **OIDC** (this section) or
**[SAML 2.0](#saml-20)**. Switching the selector keeps the other protocol's
settings, so moving between them never means re-entering a connection, and a
write that would leave the selected protocol unable to sign anyone in is refused
rather than saved. Everything after the assertion — the org's DNS-verified
authority over the email domain, issuer-bound linking, the platform-admin
refusal, the `sso` entitlement, JIT membership and group → role mapping — is
identical on both.

### How it works

- **Per-org credentials.** Each org supplies its own OIDC `clientId` /
  `clientSecret`. The client secret is encrypted at rest (per-org HKDF-derived
  key + AES-256-GCM) and is never returned in plaintext by the config API.
- **Discovery + JWKS-validated `id_token`.** The login flow reads the IdP's
  OIDC discovery document (`/.well-known/openid-configuration`), exchanges the
  authorization code, and validates the returned `id_token` signature against
  the IdP's published JWKS before trusting any identity claim.
- **Domain gating that forces SSO.** `allowedEmailDomains` pins an org to one or
  more email domains. Users in those domains are **turned away from password
  login and routed through SSO**, but only for domains the org (or its account
  root) has **verified through DNS** — listing a domain you haven't verified
  forces nothing. Only IdP users whose email matches an allowed domain may sign
  in to that org (so an over-broad corporate IdP can't let `evil-contractor.com`
  in through your `acme.com` config).
- **The org must own the email domain.** An org's own IdP can sign any address
  as verified, so an SSO sign-in is refused unless the email's domain is one the
  org (or its account root) has verified through DNS. Google (`provider:
  google`) is the exception: Google owns the addresses it signs. An SSO identity
  is linked by its subject *and* issuer, so one IdP can't claim another's users.
- **Platform administrators never sign in through an org's SSO**, and SSO never
  links onto a platform administrator's account.
- **`sso` entitlement.** SSO is a tier/bundle feature. It enforces only when the
  org's config is `enabled` **and** the org is `sso`-entitled (Team / Enterprise
  tier, or the `sso` add-on bundle). Entitlements pool at the account root, so a
  team reads its root's entitlement. A disabled or unentitled config is a no-op:
  password login keeps working and the SSO routes refuse — a half-configured or
  downgraded org never locks its users out.

### Signing in with SSO

The sign-in card offers SSO on its own, from the address the person types — they
never have to know their org's id, and an admin never has to hand out a link.

1. **Discovery.** Once the identifier looks like an email, the page asks
   `POST /auth/sso/discover` (debounced, and **once per domain** — a username is
   never asked about at all, and the request shares the pre-auth rate limit with
   login). It returns only `{ sso: boolean }` and deliberately does **not** leak
   the internal `orgId` or provider: it is unauthenticated, so returning those
   would make it a tenant-enumeration oracle. The answer is about the **domain**,
   so an address with no account behind it looks exactly like one that has.
2. **No password path for a federated domain.** On `{ sso: true }` the password
   field, the passkey button and the social buttons all go away and a single
   **"Continue with single sign-on"** action takes their place. Those three are
   all refused server-side for a covered account, so offering them only produces
   a rejection the person cannot act on.
3. **Starting the flow.** The action calls `POST /auth/sso/start` with the
   address; the enforcing org is resolved **server-side** and the same
   `{ url, state }` comes back that the by-org route returns, so the login page
   is never told which tenant owns the domain. The browser then goes to the IdP
   and returns on whichever leg the protocol uses — `/auth/sso/:orgId/callback`
   for OIDC, the [ACS](#saml-20) → `/auth/sso/:orgId/saml` for SAML.
4. **A password typed anyway.** Discovery is a hint and can miss — a username
   instead of an address, a blocked or rate-limited request. The password login
   is refused with `403 SSO_REQUIRED`, which **does** name the org and provider,
   and the card swaps to the same SSO action (labelled "Continue with Okta", say)
   initiated through `GET /auth/sso/:orgId/authorize`. A discovery that fails for
   any reason is treated as "not federated": the hint never blocks a sign-in,
   because this refusal still closes the path.

**Bootstrap admins keep their password field.** SSO refuses platform
superadmins, so `discover` answers `false` for an address in
`BOOTSTRAP_SUPERADMIN_EMAILS` — the same carve-out password login makes. Without
it, a verified SSO-enforced domain matching that address would close both ways in.

`GET /auth/sso/:orgId/authorize` returns the IdP redirect URL **for whichever
protocol the org uses** — the client just redirects to it; `POST
/auth/sso/:orgId/callback` exchanges the code and validates the `id_token`
(OIDC), while a SAML assertion arrives at its own [ACS endpoint](#saml-20).

**Social login also honors SSO enforcement.** A user in an SSO-enforced domain
cannot bypass their org's IdP by using "Sign in with Google/GitHub/…" — the
OAuth callback runs the same enforcement check as password login and rejects
with `SSO_REQUIRED`.

SSO uses the same **PKCE** protection as social sign-in — see
[PKCE on every authorization-code flow](#pkce-on-every-authorization-code-flow)
for how the issuer's advertised methods are honoured.

> **Multi-replica:** the OAuth/SSO CSRF `state`, the OIDC `nonce`, the PKCE
> `code_verifier`, and SAML's `RelayState`, request ids, spent assertion ids and
> sign-in handoff are held in the shared Redis, so the `authorize` and the
> callback (or the assertion POST) can land on different replicas. Without Redis
> they fall back to per-pod memory (single-replica only) — and a SAML replay
> guard is then only as wide as one pod, so a multi-replica SAML deployment
> **needs** Redis.

### Supported IdP providers

For `protocol: 'saml'` there is no provider list: any SAML 2.0 identity provider
works, because the connection is described by its entity ID, SSO URL and signing
certificate rather than by a name. For `protocol: 'oidc'` the providers are the
OIDC-capable set (deliberately narrower than the social-login list — a
standards-OIDC `id_token` flow is required):

- **`generic-oidc`** — any OIDC issuer with a discovery URL. Covers **Okta,
  Microsoft Entra ID, Auth0, Ping, OneLogin, Keycloak, and AWS IAM Identity
  Center**, plus any other compliant issuer (this is also the path for
  Apple / X / Amazon / Discord / Slack where they are OIDC-compliant).
- **`cognito`** — **AWS Cognito** as a named provider. The admin supplies the
  **region** + **userPoolId** and the discovery URL is **derived**
  (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration`) —
  no hand-entered URL. (A Cognito user-pool id is **not** an AWS account id and
  is safe to store.)
- **`google`** — **Google Workspace** as a named provider. The discovery URL is
  well-known, so there is none to enter; you supply the client id/secret only.
- **`github`** — **GitHub** as a named provider, for orgs already standardised on
  GitHub identities.

### Just-in-time membership and group → role mapping

An SSO sign-in **adds the person to the organization** and assigns the roles
their IdP groups map to. Nobody has to be invited separately, and role changes
made in the directory reach Pipeline Builder at the member's next sign-in.

- **Membership.** The first successful SSO sign-in creates the membership as a
  plain **member** of the SSO org. A mapping can raise the effective role by
  granting a role that confers admin, but it can never make anyone an **owner**
  and never provisions a **platform administrator** (who cannot sign in through
  an org's SSO at all). Nothing outside the SSO org is touched.
- **Groups claim.** The claim carrying group membership is configured per IdP
  (`groupsClaim`): `groups` for Okta and Keycloak, `cognito:groups` for Cognito,
  `roles` for Entra. Leave it empty for the `groups` default. Matching ignores
  case. **Not available for Google** — Google's OIDC tokens carry no group claim
  (group data lives behind the Workspace Admin SDK), so setting the claim or
  creating a mapping on a `google` config is refused with an explanation. Google
  SSO users are still added to the org as members.
- **Mappings.** Each rule maps one group to a set of the org's roles; a member of
  several mapped groups gets the union. Editing them requires **`roles:manage`**
  — a mapping *is* a role grant — plus the org's own `sso` entitlement, and each
  role must be within the editor's own permission ceiling, exactly as a direct
  role assignment is. A mapping can never name a role granting platform-admin.
- **Manual roles are separate.** Roles an administrator assigns by hand are
  tracked separately (`source: manual`) and are **never removed by a sync** —
  only roles a mapping granted are withdrawn when the group stops matching. An
  admin who re-grants a mapped role by hand takes ownership of it permanently.
- **Seats.** JIT goes through the same pooled seat check as invitations. If the
  account is at its seat limit, **the sign-in is refused** with a seat-limit
  message (rather than opening a session with no membership); the refusal is
  audited (`sso.jit.refused`) and counted
  (`platform_sso_jit_refused_total{reason="seat_limit"}`). Free a seat or raise
  the limit, and the next sign-in succeeds.
- **Deactivated members stay deactivated.** If an admin has deactivated someone's
  membership, a later SSO sign-in does not silently reactivate it.
- **Entitlement.** JIT and mapping live inside the existing `sso` entitlement —
  there is no separate add-on. After a downgrade JIT turns off along with SSO;
  memberships and roles already granted stay exactly as they are.

Mappings are managed on **Settings → Single Sign-On**, or through
`GET/POST /organization/:id/idp/group-mappings` and
`PUT/DELETE /organization/:id/idp/group-mappings/:mappingId`. Every provision and
role change is audited (`sso.jit.provision`, `sso.jit.role.change`) and counted
(`platform_sso_jit_provisioned_total`).

> **Operator note (fresh behaviour, no migration):** orgs that already have SSO
> configured start provisioning memberships on the next sign-in. Until a mapping
> exists, members get the built-in Member role only — existing role assignments
> are untouched because they are all `manual`.

### SCIM 2.0 provisioning

Just-in-time provisioning only reaches people who **sign in**. SCIM closes the
other half: the directory pushes creates, updates, deactivations and group
membership as they happen, so someone removed in the IdP loses access here
without waiting for anyone to notice.

**Base URL:** `https://<your-host>/api/scim/v2` — the same for every
organization. There is no org id in any path: the org is the one the presenting
key belongs to, so a mis-copied URL can only ever fail, never cross tenants.

**Credential:** a service-account key carrying the **`scim` scope**, issued on
**Settings → Single Sign-On → SCIM provisioning** (which creates a dedicated
`scim-provisioning` service account on first use). Present it as
`Authorization: Bearer pb_sa_…`. A person's token is refused outright — SCIM is
machine-to-machine by construction — and a scoped key carries no permissions at
all, so it can do exactly this and nothing else. Issuing one requires
`service_accounts:manage` and a step-up confirmation, like every key mint.

The IdP presents the **opaque key itself** (no exchange step — platform owns the
key collection and resolves it in place), so each request consumes one unit of
the owning account's token-exchange budget. The `scim-provisioning` account is
created with an unlimited budget; if you set one by hand, size it for a full
directory sync. Revoking the key stops provisioning within five minutes and
deactivates nobody.

**Endpoints** (`application/scim+json` throughout):

| Resource | Methods | Filters |
|---|---|---|
| `/Users` | `GET` (list), `POST` | `userName eq`, `externalId eq`, `active eq`, `emails.value eq` |
| `/Users/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` | — |
| `/Groups` | `GET` (list), `POST` | `displayName eq`, `externalId eq` |
| `/Groups/{id}` | `GET`, `PUT`, `PATCH`, `DELETE` | — |
| `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | `GET` | — |

Lists page with `startIndex` (1-based) and `count` (default 100, max 200) and
answer a `ListResponse`. An unsupported filter is a `400` with
`scimType: "invalidFilter"` — never a silent full list, which would make an IdP
conclude a user doesn't exist and create a duplicate. Errors are RFC 7644
`…:2.0:Error` documents with a **string** `status`.

What the resources mean here:

- **A SCIM User is one org membership.** Its `id` is the platform user id.
  Directory-owned attributes (`externalId`, `userName` as sent, names) are stored
  **on the membership**, never on the account: a tenant's directory must not be
  able to rewrite the email or username of someone who also belongs to another
  org. `userName` is therefore **write-once** — changing it is a `400`
  `mutability`; remove the user and provision the new address instead.
- **A SCIM Group is a group → role mapping rule** — the same rows the editor
  above writes. SCIM owns the group's **name and members**; it **never sets
  roles**. What a group is worth stays a decision made here by someone holding
  `roles:manage`, so a stolen SCIM key can move people between groups but cannot
  invent a group that grants admin. A group the directory pushes grants nothing
  until you map it.
- **Roles follow group membership** through the same resolver JIT uses, and
  SCIM-driven assignments are sync-owned: a role an admin granted by hand is
  **never removed by a sync**.

The rules a sync runs into:

- **Verified domains.** A user can only be provisioned at an email whose domain
  the org (or its account root) has verified under Settings → Domains. Anything
  else is a `400` `invalidValue`. Without this, knowing an address would be
  enough to staple a membership onto someone else's account.
- **Seats.** Creating past the pooled seat limit is refused with a `403` whose
  `detail` names the seat limit. There is no overage and nothing is
  half-provisioned. Reactivating (`active: true`) is charged the same way.
- **Deactivation is immediate.** `PATCH active:false` or `DELETE` deactivates the
  membership, drops the roles the directory granted, **bumps `tokenVersion` and
  clears the refresh-session slots in the same transaction**, and publishes the
  revocation — so every outstanding token fails on its next request against every
  service, not at expiry. `DELETE` keeps the membership row (it holds the audit
  trail, the hand-granted roles and the seat accounting) and is idempotent.
- **Never.** The org **owner** is never deactivated or removed (transfer
  ownership first — `403`), and a **platform administrator** is never provisioned
  or touched at all.
- **Unmodelled attributes are ignored**, not refused. Entra and Okta send phone
  numbers and the enterprise-user extension unconditionally; a `400` there would
  stall a whole run over something that changes nothing here.
- **Rate limit.** Per **organization** (600 requests/minute), in its own bucket —
  a directory sync neither spends nor is throttled by the org's interactive API
  budget. An org that issues five SCIM keys still gets one sync budget.

**Entitlement, and what a downgrade does.** SCIM rides the same `sso` entitlement
as OIDC SSO and JIT — no separate add-on. After a downgrade the surface becomes
**removal-only**, deliberately:

| After a downgrade | |
|---|---|
| `GET` (any) | **works** — an IdP must look a user up before it can deactivate them |
| `PATCH active:false`, `DELETE /Users/{id}` | **works** — removing someone in the directory still removes their access |
| `DELETE /Groups/{id}`, removing group members | **works** — these only ever remove access |
| create, update, reactivate, add group members, rename a group | **refused** (`403`, `detail` explains) |

A `PATCH` that deactivates **and** changes an attribute is refused as a whole, so
nothing is half-applied. The first refusal emails and in-app-notifies the org's
owners and admins (throttled to once a day), because otherwise a downgraded org
sees removals keep working while new hires silently stop appearing.

**Audit and metrics.** Every change is audited — `org.scim.user.create`,
`.update`, `.activate`, `.deactivate`, `.delete`, `org.scim.group.create`,
`.update`, `.members`, `.delete` — recording *which* attributes moved, never
their values. Every refusal is `org.scim.refused` with `details.reason`
(`seat_limit`, `not_entitled`, `invalid_filter`, `owner_protected`, …). Metrics:
`platform_scim_requests_total{resource,operation,result}` and
`platform_scim_errors_total{resource,operation,reason}`.

> **Validator note:** the Okta and Microsoft Entra hosted SCIM validators need a
> publicly reachable endpoint and a live tenant, so running them is a manual
> pre-release step. Their documented request shapes are encoded as fixtures in
> `platform/test/scim-protocol.test.ts` so the parsing stays honest in CI.

### IdP setup walkthroughs

Each walkthrough registers **one OIDC application per org** in the identity
provider, whitelists the org's callback URL, and copies the resulting values into
the [`OrgIdpConfig`](#two-config-surfaces) fields (`provider`, `clientId`,
`clientSecret`, and either `discoveryUrl` or Cognito's `region` + `userPoolId`).
The engine requests scopes `openid email profile` and validates the returned
`id_token` against the IdP's JWKS.

**The redirect / callback URL to whitelist** — this is per-org, so it embeds the
org id:

```
<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback
```

for example `https://ci.acme.com/auth/sso/2f9c…/callback`. Find `<orgId>` on the
IdP/SSO config page (superadmin `/admin/org-idp`, or the org's own settings). A
mismatch here is the most common cause of a failed SSO login.

#### Okta (generic-oidc)

1. Okta Admin → **Applications → Create App Integration → OIDC - OpenID Connect → Web Application**.
2. **Sign-in redirect URIs** → add `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`. Grant type: **Authorization Code**.
3. Assign the app to the users/groups who should reach this org.
4. Copy **Client ID** and **Client secret**; the discovery URL is `https://<your-okta-domain>/.well-known/openid-configuration`.
5. In the SSO config set `provider: generic-oidc`, `clientId`, `clientSecret`, `discoveryUrl`.

#### Microsoft Entra ID (generic-oidc)

1. [Entra admin center](https://entra.microsoft.com) → **App registrations → New registration**.
2. **Redirect URI** → platform **Web** → `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`.
3. **Certificates & secrets → New client secret** → copy the **Value**; copy the **Application (client) ID** from Overview.
4. Discovery URL: `https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration`.
5. Set `provider: generic-oidc`, `clientId`, `clientSecret`, `discoveryUrl`.

#### Google Workspace (`google`)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **Create Credentials → OAuth client ID → Web application** (configure the consent screen first if prompted).
2. **Authorized redirect URIs** → add `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`.
3. Copy the Client ID/secret.
4. Set `provider: google`, `clientId`, `clientSecret` — the discovery URL is well-known (`https://accounts.google.com/.well-known/openid-configuration`), so you don't enter one.

#### Auth0 (generic-oidc)

1. Auth0 Dashboard → **Applications → Create Application → Regular Web Application**.
2. **Settings → Allowed Callback URLs** → add `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`.
3. Copy **Client ID** and **Client Secret**; discovery URL is `https://<your-tenant>.<region>.auth0.com/.well-known/openid-configuration`.
4. Set `provider: generic-oidc`, `clientId`, `clientSecret`, `discoveryUrl`.

#### Keycloak (generic-oidc)

1. Keycloak Admin → select the realm → **Clients → Create client** → type **OpenID Connect**, **Client authentication: On** (confidential).
2. **Valid redirect URIs** → add `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`.
3. **Credentials** tab → copy the client secret; the client id is the name you set.
4. Discovery URL: `https://<keycloak-host>/realms/<realm>/.well-known/openid-configuration`.
5. Set `provider: generic-oidc`, `clientId`, `clientSecret`, `discoveryUrl`.

#### AWS Cognito (cognito)

1. Cognito console → your **User pool → App integration → Create app client** (a **confidential** client with a secret).
2. **Hosted UI / Allowed callback URLs** → add `<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback`; enable the **Authorization code grant** and `openid email profile` scopes.
3. Copy the app client **id** and **secret**, and note the pool's **region** and **User pool ID**.
4. Set `provider: cognito`, `clientId`, `clientSecret`, `region`, `userPoolId` — **do not** set `discoveryUrl`; it's derived as `https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration`.

> Before enabling, verify ownership of your email domains (DNS TXT, under the
> org's domains settings) — SSO refuses sign-ins on unverified domains.
> After saving, set `allowedEmailDomains` to force those domains through SSO, flip
> `enabled: true`, and confirm the org is `sso`-entitled. Secret-bearing writes
> require step-up re-authentication on both config surfaces.

### SAML 2.0

For organizations whose identity provider speaks SAML rather than OIDC. It is
the **same** sign-in path: the same `GET /auth/sso/:orgId/authorize` starts it,
the same verified identity comes out, and the same checks decide whether that
identity may become a session — the org's DNS-verified ownership of the email
domain, issuer-bound account linking, no platform-administrator sign-in, the
`sso` entitlement, and just-in-time membership when it is enabled. SAML rides
that entitlement; it is **not** a separate add-on.

Set it on **Settings → Single Sign-On**, under the same `org:idp` capability and
step-up confirmation as the OIDC connection.

#### What to give your identity provider

Both values are derived from your organization id and this deployment's public
URL, so they exist before the connection does:

| | |
|---|---|
| Service-provider entity ID | `https://<your-host>/api/auth/sso/<orgId>/saml/metadata` |
| Assertion Consumer Service (ACS) URL | `https://<your-host>/api/auth/sso/<orgId>/saml/acs`, binding **HTTP-POST** |
| Metadata document | `GET` the entity-ID URL — most IdPs can import everything from it |

Sign **both** the response and the assertion. Pipeline Builder does not sign
authentication requests, so there is no service-provider certificate to install
and none to rotate.

#### What to configure here

| Field | What it is |
|---|---|
| **Identity provider entity ID** | The IdP's `entityID`. Every assertion's `Issuer` must equal it, so one org's IdP can never mint an assertion another org's config accepts. |
| **Identity provider SSO URL** | The IdP's HTTP-Redirect single sign-on endpoint. Must be `https`. |
| **Signing certificate(s)** | The IdP's signing certificate, PEM or bare base64. A **list** — see [rotation](#rotating-the-idp-signing-certificate). Up to three at once. |
| **Attribute mapping** | Which assertion attribute carries **email**, **name** and **groups**. Leave a field empty to try the common spellings (`email`/`mail` and the Entra/Shibboleth URI forms; `displayName`; `groups`). An email-shaped `NameID` is used when no email attribute is present. |

Groups feed the same [group → role mapping](#just-in-time-membership-and-group--role-mapping)
rules OIDC uses, normalised the same way (trimmed, case-insensitive,
de-duplicated), so one rule set governs both protocols. The Google carve-out does
not apply to SAML — groups come from a mapped attribute, not a token claim.

#### What an assertion has to satisfy

- **Service-provider-initiated only.** Sign-in must start at Pipeline Builder. A
  response with no `InResponseTo` is **refused**: an unsolicited assertion is a
  login-CSRF and replay primitive, because nothing ties it to a browser that
  asked to sign in. The request id is additionally checked against one this
  deployment actually minted (held in the shared Redis, so the initiate and the
  assertion may land on different replicas). There is no IdP-initiated entry
  point to enable — starting from your IdP's app launcher will not work, by
  design.
- **Signed, by a certificate you configured.** XML-DSig over both the response
  and the assertion, verified against the org's trust list. The document's own
  `KeyInfo` is never trusted.
- **Issued for this organization.** `Issuer` must equal the configured entity ID
  and the `AudienceRestriction` must name this org's SP entity ID — so an
  assertion minted for another service provider by the same IdP is refused.
- **Inside its validity window.** `NotBefore` / `NotOnOrAfter`, with a small
  clock-skew allowance (`SAML_CLOCK_SKEW_MS`, default 60 s) for ordinary NTP
  drift — not a way to accept stale assertions.
- **Used once.** The assertion's `ID` is claimed in Redis until the assertion
  expires, so the same assertion can never be presented twice, on any replica.

Every refusal is audited (`sso.saml.refused` with a stable `details.reason`) and
counted (`platform_saml_signins_total{result}`); a successful sign-in is a
`user.login` with `details.method = 'saml'` and `result="success"`.

#### How the browser gets its session

SAML delivers its assertion by an IdP-driven form POST to the ACS — a server
endpoint — so, unlike OIDC, the frontend never sees it. The ACS verifies the
assertion, provisions the membership, and redirects to
`/auth/sso/:orgId/saml` with a **one-time, org-bound handoff**; that page
redeems it (`POST /auth/sso/:orgId/saml/complete`) and the session is minted
there. No token ever travels through a URL, and the session records the browser
that actually redeemed the handoff. A refused assertion redirects to the same
page with an `error` code instead.

#### Rotating the IdP signing certificate

The certificate field is a **list**, and that is the whole rotation story: while
both the outgoing and the incoming certificate are listed, assertions signed by
either verify, so nobody is locked out mid-cutover. Add the new certificate, let
your IdP cut over, then remove the old one. Changes are audited
(`sso.saml.certificate.rotate`, with fingerprints before and after and whether an
overlap window is now open). Full procedure:
[secret rotation → IdP SAML signing certificates](runbooks/secret-rotation.md#idp-saml-signing-certificates-per-org).

#### Not in this release

- **Single logout (SLO) is out of scope.** There is no SLO endpoint, no
  `logoutUrl` setting and no `SessionIndex` bookkeeping — nothing half-built to
  turn on. Signing out of Pipeline Builder ends the Pipeline Builder session
  only; it does **not** sign the person out of your identity provider. Sign-out
  at the IdP likewise does not end an already-open Pipeline Builder session;
  what does is [SCIM deactivation](#scim-20-provisioning), which revokes the
  person's sessions immediately.
- **Encrypted assertions** are not accepted. Configure your IdP to sign but not
  encrypt; TLS already protects the assertion in transit.
- **SAML is not a step-up factor.** Step-up needs a fresh re-authentication read
  back from the popup the provider redirects to, and a SAML assertion lands on a
  server-side ACS instead. A SAML-only account steps up with a
  [passkey](#passkeys-webauthn), an [authenticator app](#authenticator-app-totp),
  or a password; the step-up modal does not offer an SSO button for a SAML org,
  and a client that asks anyway is told so.

### Two config surfaces

The same `OrgIdpConfig` is manageable from two places, which stay in lockstep
(shared service, quota reservation, and audit actions):

| Surface | Who | Where |
|---------|-----|-------|
| **Superadmin / fleet** | Platform operators (Super Admin) | `/admin/org-idp` — register or edit SSO for **any** org on their behalf (the "IdP / SSO" dashboard page). |
| **Org-admin self-service** | An org's own admin | Managed under the org's settings (Settings → Single Sign-On), gated on the `org:idp` capability — the customer's admin configures their own org's SSO, on **either protocol**, without an operator (`GET`/`PUT`/`PATCH`/`DELETE /organization/:id/idp`). |

Both surfaces gate the secret-bearing writes behind step-up re-authentication,
and the self-service surface additionally requires the org to be `sso`-entitled
and only lets an admin touch their own org (or a team they manage). Every
create / update / delete is recorded in the [audit trail](audit-events.md)
(`admin.org-idp.upsert` / `admin.org-idp.delete`).

---

## Step-up re-authentication (every account)

Sensitive actions — deleting an account or org, minting a PAT, rotating KMS,
granting platform-admin, starting an impersonation, restoring soft-deleted data,
writing an IdP secret — need a **step-up**: a fresh proof of identity in addition
to the session, replayed as the `X-Step-Up-Token` header (60s, single-use,
caller-bound). Step-up is **factor-agnostic**: every factor mints the same token,
so the `requireStepUp` gate on every service is identical.

| Factor | Endpoint | Who has it |
|--------|----------|------------|
| **Passkey** | `POST /auth/step-up/webauthn/options` → `/verify` | Anyone who has added one. Offered first — it is the strongest of the four and takes a touch rather than a typed secret. |
| **Authenticator app** | `POST /auth/step-up/totp` `{ code }` | Anyone with a TOTP enrolment. Offered second: it proves possession of a device, and it is the one factor that works on a machine with no passkey. A recovery code satisfies it too. |
| **Password** | `POST /auth/step-up` `{ password }` | Accounts created with email + password. |
| **Provider re-auth** | `POST /auth/step-up/reauth` → `POST /auth/step-up/reauth/callback` | Accounts with a linked social provider or org SSO — including the Google/GitHub/SSO accounts that have **no password at all** and previously could not pass step-up. |

`GET /user/profile` reports what the account has as `authFactors`
(`hasPassword`, `passkeyCount`, `hasTotp`, `providers[]`), and the step-up dialog
offers exactly those. The token records how it was earned
(`method: 'password' | 'webauthn' | 'totp' | 'reauth'`), which is also in the
audit event; a TOTP step-up additionally carries `mfa` in the token's `amr`. All
four share ONE per-user budget of 5 attempts a minute — a limit that reset per
factor would just be the loosest of them — and TOTP adds a per-account lockout on
top, because a 6-digit code is small enough that a request limiter alone is not
the real bound.

### How provider re-auth works

1. The dialog calls `POST /auth/step-up/reauth` with the chosen provider
   (`{ type: 'oauth', provider }` or `{ type: 'sso', orgId }`). It must be one of
   the account's own `authFactors.providers`, or the request is refused.
2. The server mints a single-use `state` (prefixed `reauth.`, stored in the
   shared Redis pending-state store, bound to the signed-in user, ≤5 min) and
   returns the provider authorize URL with the provider's "sign in again"
   parameters (OIDC `prompt=login` + `max_age=0`).
3. The browser opens that URL in a **popup**. The provider redirects back to the
   ordinary callback page (`/auth/callback/:provider` or
   `/auth/sso/:orgId/callback`), which recognizes the `reauth.` prefix, hands
   `code` + `state` to the window that opened it (same-origin only) and closes.
4. That window calls `POST /auth/step-up/reauth/callback`. Verification is the
   same as sign-in — social code exchange + verified userinfo, or the SSO
   `id_token` (JWKS signature, issuer, audience, nonce, the org's verified-domain
   authority) — **plus**: the identity must be the one already linked to the
   account (provider subject, and issuer for SSO; never merely the same email),
   and the sign-in must be fresh (see below). Only then is the step-up token
   issued.

Rate limits and auditing match the password path: 5 attempts/minute per user,
failures as `user.login.failed` (`targetType: 'step-up'`), successes as
`user.step-up`, and both counted in `platform_step_up_total{method,outcome}`.
Read-only impersonation blocks these POSTs like any other write, and platform
administrators can never step up through a tenant-run IdP (they can't sign in
through one either).

### Recency, per provider

The server checks the provider's `auth_time` claim against the moment the
re-auth started (60s clock skew). What a provider can prove differs:

| Provider | Re-prompt sent | Recency |
|----------|----------------|---------|
| Generic OIDC / Cognito (org SSO) | `prompt=login` + `max_age=0` | **Required** — `max_age` obliges a conformant IdP to return `auth_time`; a missing claim is refused. |
| Google (social or SSO) | `prompt=select_account` + `max_age=0` | Enforced only when Google returns `auth_time`. Google rejects `prompt=login` and does not honour `max_age`, so the account picker is the strongest re-prompt available. |
| Microsoft, GitLab, LinkedIn | `prompt=login` + `max_age=0` | Enforced when the `id_token` carries `auth_time`. |
| GitHub | `prompt=select_account` | **Not available** — GitHub is plain OAuth2 (no `id_token`, `max_age` or `auth_time`), so re-auth proves a live GitHub session for the linked account, not a fresh password entry. |
| Facebook | `auth_type=reauthenticate` | Facebook re-prompts for the password but reports no `auth_time`, so recency isn't independently verifiable. |

Where recency can't be proven the audit event records
`recencyVerified: false`. Accounts that need the strongest step-up should add a
passkey, whose assertion is always fresh.

> **Operators**: the re-auth popup reuses the sign-in `redirect_uri` you already
> registered — no new provider configuration. The SSO popup needs the frontend
> page at `/auth/sso/:orgId/callback`, which is the URL the IdP already has.
> Redis is what makes the `state` visible across platform replicas (see
> [Environment Variables](environment-variables.md#authentication)).

---

## Passkeys (WebAuthn)

A passkey is a key pair the person's own device holds. Signing in proves
possession of that device plus a local unlock (fingerprint, face, PIN), and the
private half never leaves it — so there is nothing to phish, reuse or leak in a
breach. Nothing needs configuring: a person adds one from
**Dashboard → Security → Factors → Passkeys** and it works from then on.

Passkeys do three jobs here:

- **Sign in** without a password, including from the browser's autofill dropdown.
- **Step up** before a sensitive action — the passkey path is offered first.
- Give the Google/GitHub/SSO accounts that have **no password** a factor of their
  own, so they no longer depend on a provider round trip.

### Adding one

Enrolment is step-up gated, and step-up is factor-agnostic — so an account with
a password re-enters it, and an account without one re-authenticates with its own
provider. Either way the same token unlocks the ceremony, and that is how a first
passkey gets added to a passwordless account.

Enrolment and removal additionally require an **interactive session**: never an
access key, never a scoped machine credential, and never an impersonated session,
so an operator viewing an account can't leave a credential behind in it.

Every passkey is created as **discoverable** (`residentKey: required`) with
**user verification required**. Discoverable is what lets sign-in work before the
person has typed anything; user verification is what makes the assertion a proof
of *who*, not just of *which device*.

### Removing one

Refused (`409`) when it is the account's only way in — no password, no linked
provider, no other passkey. The credential on the device itself is not deleted;
that has to be done in the device's own settings.

### Signing in

The sign-in field carries `autocomplete="username webauthn"`, and where the
browser supports conditional UI a challenge is armed on page load, so a returning
user signs in by picking their account from the autofill dropdown. Browsers
without conditional UI get the explicit **Sign in with a passkey** button; both
paths end at the same endpoint and open the same session as a password sign-in
(same `issueTokens`, same refresh cookie, `amr: ['webauthn']`).

Passkey sign-in obeys the same rules as password sign-in: **refused for
SSO-enforced domains** (those users must go through their IdP), the same
rate-limit posture, and one opaque `401` for every failure. Passkey *step-up* is
still allowed for an SSO-enforced account — that person is already inside a
session their IdP admitted.

### The relying party

The RP ID and the accepted origins come from **configuration, never from the
request**: RP ID is the exact hostname of `PLATFORM_FRONTEND_URL`, and the
default origin is its scheme + host + port. A `Host:`-derived RP would let anyone
who can reach the service mint challenges for a domain of their choosing.

> **The RP ID is permanent.** Every passkey is bound to the value in force when it
> was registered; changing it orphans every credential already enrolled, with no
> migration. Platform refuses to boot on an IP-address RP ID, an origin outside
> the RP ID, or a plain-`http` origin other than `http://localhost`. See
> [Environment Variables → Passkeys](environment-variables.md#passkeys-webauthn).

### Cloned-credential detection

Authenticators that count signatures must count **up**. A credential whose stored
counter is above zero and comes back equal or lower means two authenticators are
answering for one credential — a clone. The assertion is refused and
`user.passkey.clone_suspected` is audited. Synced passkeys legitimately report
`0` forever, so the check only applies once a credential has counted at least
once.

### What gets recorded

`user.passkey.register`, `user.passkey.rename`, `user.passkey.remove` and
`user.passkey.clone_suspected`; sign-in and step-up carry
`details.method: 'webauthn'`, and failures are `user.login.failed` with the
refusal reason the caller is deliberately not told.

---

## Authenticator app (TOTP)

A 6-digit code from an app on the person's phone (Google Authenticator,
1Password, Aegis, iOS Passwords, …), asked for **after** the password. It is the
factor for people and devices without a passkey, and unlike a passkey it works
from any machine the person signs in from.

Like passkeys, it needs no operator configuration: a person turns it on from
**Dashboard → Security → Factors → Authenticator app**.

### What it does

- **Guards password sign-in.** Once it is on, the password alone no longer
  completes a sign-in (see below).
- **Steps up** before a sensitive action — offered second, after a passkey.

### The parameters are fixed

RFC 6238, **SHA-1 / 6 digits / 30 seconds**, with a **±1 step** drift allowance.
Not because they are the strongest available, but because they are the only
combination every authenticator reads reliably from an `otpauth://` URI — several
silently ignore `algorithm` and `digits`, which produces an enrolment that scans
cleanly and then never verifies. The secret is 160 random bits, so SHA-1's
collision weakness is irrelevant: HMAC-SHA1's security rests on PRF strength, and
the real bound is the 6-digit code plus the lockout.

A wider drift window is the usual way TOTP gets weakened — every extra step is
another live code to guess — so it stays at one, i.e. a code is good for at most
90 seconds.

### Turning it on

Enrolment is two steps, and is **step-up gated** plus restricted to an
**interactive session** (never an API key, a scoped machine token, or an
impersonated session — an operator viewing an account must not be able to leave a
factor behind in it, or take one away):

1. `POST /auth/totp/enrol` mints a secret and returns it **once**, as an
   `otpauth://` URI (rendered as a QR) and as a typed setup key. Nothing is
   protecting the account yet.
2. `POST /auth/totp/activate` takes a code from the app. Confirming with a real
   code — rather than trusting the scan — is the point of the two-step flow: it
   proves the secret reached a working authenticator before the account starts
   depending on it. This is also where the **recovery codes** are minted.

An enrolment abandoned halfway is simply replaced by the next one, with a **new**
secret: the old one was displayed, so it must never be the one that ends up
confirmed. Re-enrolling over a *working* authenticator is refused — silently
rotating the secret under a live app is how people lock themselves out. Disable
first (which takes its own step-up).

**Refused for SSO-enforced addresses.** When an org has verified the domain and
turned SSO on, the identity provider owns the factors; a second, unmanaged MFA
its admins can neither see nor revoke is worse than none.

### The secret at rest

Stored as an AES-256-GCM `EncryptedBlob` under `SECRET_ENCRYPTION_KEY`, with the
key HKDF-derived for the owning user. A row lifted into another account's record
fails its authentication tag, and a database dump without the master key yields
nothing. The `usertotps` collection also hides the secret and the recovery hashes
from ordinary reads (`select: false`), so a route that forgets a projection
cannot leak either.

### Signing in

A password sign-in for an account with TOTP does **not** complete on the password:

1. `POST /auth/login` verifies the password and answers
   `{ mfaRequired: true, challengeId, expiresAt }` — no access token, no refresh
   cookie, no session slot. The sign-in is not audited as having happened.
2. `POST /auth/mfa/verify` `{ challengeId, code }` opens the session the login
   would have, with `mfa` added to `amr`.

The challenge is 256 random bits naming a row in the shared Redis pending-state
store, so it can be invalidated the instant it is spent. A **wrong** code does not
burn it — a mistyped digit sending someone back to re-enter their password would
push people towards weaker factors — but a correct one does, so one handle can
never yield two sessions. Guessing is bounded twice: a per-challenge rate limit
and the per-account lockout. The challenge expires after 5 minutes regardless.

Every refusal is the same opaque `401` the password path gives, with the reason
only in the audit trail — with two exceptions. SSO enforcement, re-checked on the
second leg (an org can turn it on between the two), answers the same
`403 SSO_REQUIRED` naming the org. And an unknown or already-spent challenge
answers `401 TOTP_INVALID_CHALLENGE`: the handle is 256 unguessable bits, so
saying it is gone is no oracle, and retrying a code against a dead challenge can
only fail forever — the sign-in page sends the person back to the password field
instead of asking for more codes.

The CLI is unaffected: `pipeline-manager auth login` hands the sign-in to a
browser through the device authorization grant, so it inherits whatever the
account uses. **`docker login` against the image registry is affected** — Basic
auth has nowhere to carry a code, so an account with TOTP is refused there and
should push with an [access key](#access-keys-opaque-verified-by-exchange)
instead (`docker login -u <anything> -p pb_pat_…`).

### Replay, drift and lockout

- **A code and time step are spent once.** Every acceptance records the step it
  consumed, and the next verification accepts only a strictly greater one, claimed
  with a conditional update — so two concurrent uses of one code race and exactly
  one wins. That is what stops a phishing proxy replaying the code it just
  relayed, and it also rules out an earlier step still inside the drift window.
- **Repeated failures lock the account's TOTP out** (`TOTP_MAX_FAILURES`
  consecutive wrong codes, then `TOTP_LOCKOUT_MS`). It applies to sign-in and
  step-up alike, and recovery codes share the counter — guessing one does not
  earn a fresh budget. On the sign-in path a lockout answers the same opaque
  `401` as a wrong code (saying otherwise would confirm the password was right);
  on the step-up path, where the caller is already authenticated, it is a `429`
  with actionable wording.

### Recovery codes

Ten one-time codes, minted at activation and shown **once** — only SHA-256 hashes
are stored (a recovery code is 50 bits of uniform randomness nobody chose, so
there is no dictionary for a work factor to slow down). They are accepted
anywhere a generated code is: the sign-in exchange and the step-up endpoint.

A spent code is kept and marked, so it is refused as *spent* rather than as
*unknown*, and the settings page can say "7 of 10 remaining". Regenerating
replaces the **whole** set — "some of these still work" is not a state anyone can
reason about — and is step-up gated, because it invalidates every code already
written down.

### Turning it off

`DELETE /auth/totp` (step-up gated, interactive session) removes the secret and
every recovery code. Refused when it would leave the account with no way to sign
in at all — the same guard that stops the last passkey from being removed, asked
through the same helper so the two cannot disagree. TOTP is deliberately **not**
counted as a way in by that guard: it is a second factor on a password sign-in, so
an account holding only TOTP could not get in at all.

> **Losing both.** A person who loses their authenticator *and* their recovery
> codes cannot self-serve back in. Recovery is an operator action with database
> access (delete their `usertotps` row), and should be treated as the privileged,
> out-of-band step it is.

### Assurance

A TOTP-backed sign-in carries `amr: ['pwd', 'mfa']` and reaches **`aal: 2`**; a
TOTP step-up carries `amr: ['stepup', 'mfa']` and `method: 'totp'`, which is one
of the two factors the most dangerous routes will accept. See
[Assurance levels and required MFA](#assurance-levels-and-required-mfa).

### What gets recorded

`user.totp.enrol` (twice — `details.stage` is `started` then `activated`),
`user.totp.disable`, `user.totp.recovery_regenerate` and `user.totp.recovery_used`
(`details.context` is `login` or `step-up`). Sign-in records
`details.method: 'pwd+totp'` with `details.via` saying whether a generated or a
recovery code was used; wrong codes are `user.login.failed` with
`details.method: 'totp'`, so brute-force shows up on the same trail as password
guessing. Verifications are metered as
`platform_totp_verifications_total{stage,outcome}` (`stage` is `activate`,
`stepup` or `login`; `outcome` is `success`, `recovery`, `failure` or `locked`),
step-ups also land in `platform_step_up_total{method='totp',outcome}`, and every
issued sign-in challenge counts in `platform_mfa_challenges_total` — comparing it
with the `login` successes is how a stuck second leg shows up.

---

## Assurance levels and required MFA

Every session carries an **authenticator assurance level** (`aal`), and routes
and organizations can demand a minimum.

### What the levels mean

| `aal` | How the session was opened |
| --- | --- |
| `1` | A password, a social sign-in (Google/GitHub/…), or SSO through an IdP the org has **not** marked as enforcing MFA. |
| `2` | A **passkey** asserted with user verification; a **password plus an authenticator code** (or a recovery code); or **SSO** through an IdP the org **has** marked as enforcing MFA. |

The level is fixed **when the session is opened** and stored on its
refresh-session slot alongside `amr` and `auth_time`. Refresh, renewal and
switch-org copy it verbatim, so **a refresh can never raise it** — earning `aal:
2` always means authenticating again, with a factor. That is why the UI answers
an `MFA_REQUIRED` refusal with "enrol, then sign in again" rather than with a
token refresh.

**Why the IdP setting is a per-org statement, not a claim we read.** Most OIDC
providers send no `amr` at all, and a SAML `AuthnContextClassRef` is whatever the
IdP was configured to emit. The org administers its own provider, so its own
statement is the best available evidence — `idpEnforcesMfa` on the org's
two-factor settings. Leave it off unless the IdP genuinely requires a second
factor.

### Requiring it on a route

```ts
router.post('/dangerous',
  requireAuth({ minAssurance: 2 }),        // or: requireAuth, requireAssurance({ minAssurance: 2 })
  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  handler);
```

- `minAssurance` is about the **session**: a weaker one gets **401
  `MFA_REQUIRED`**. Adding `maxAge` (seconds) also bounds `auth_time`; a session
  that is strong but stale gets **401 `REAUTH_REQUIRED`**.
- `requireStepUp` stays a **per-action** confirmation. Passing `methods` demands
  that the confirmation was earned by a specific factor; a token earned another
  way is refused with **401 `STEP_UP_METHOD_REQUIRED`** and is *not* consumed, so
  it can still be spent where it is accepted.
- **Machine credentials never satisfy `minAssurance`.** An internal service
  principal, an org service account and any exchanged access key (`pb_pat_…` /
  `pb_sa_…`) all get **403 `HUMAN_SESSION_REQUIRED`** — there is no person behind
  them to have presented a factor. Point automation at a machine-facing route
  instead.

Platform's own `requireAuth` reads MongoDB and takes no options, so it composes
`requireAssurance({ … })` after it; both call the same check.

#### Where it is enforced today

Assurance and a **second-factor** step-up (`STRONG_STEP_UP_METHODS` — passkey or
authenticator code; a password re-prompt proves nothing an attacker holding the
session doesn't already have) are required on:

- starting, redeeming or break-glassing an **impersonation** session;
- writing a **per-org KMS** configuration (`/admin/orgs/:orgId/kms-config`);
- writing an **IdP configuration**, self-serve (`/organization/:id/idp`) or
  fleet (`/admin/org-idp/:orgId`);
- granting or revoking **platform-admin** (`/admin/users/:id/grants`).

Reads on those surfaces are unchanged. Nothing else gets `minAssurance` until the
people who use it can enrol — which they now can.

### Requiring it for an organization

**Settings → Organization → Two-factor authentication** (needs `org:settings`,
and the save is step-up gated because turning it *off* removes a control for
every member).

- Enforced **when a token is issued**, never per route: a session scoped to the
  org is minted at `aal: 2` or refused. It therefore covers every route of every
  service, including ones added later.
- The token carries an `mfaRequired` claim, so no service looks the policy up.
- A **grace period** (14 days by default, 0–90) follows turning it on. During it
  members are told — a banner with the deadline, and the enrolment link — but not
  refused. The deadline is computed server-side from a day count, so a client can
  never post one of its own, including one in the past.
- The requirement is **inherited**: a parent org's requirement applies to its
  teams, and a team cannot opt out of it (it may add one of its own).
- Once the grace ends, an `aal: 1` session stops being re-issued: sign-in,
  refresh, switch-org and generate-token all answer **401 `MFA_REQUIRED`**.
  Scoped machine credentials (`reporting:ingest` and friends) are exempt — they
  are not a person's session, and they are already refused by every
  `minAssurance` gate.

### The bootstrap-administrator exception

A fresh install has exactly one administrator and no enrolled factor, so
requiring MFA would lock out the only person who can enrol one. The exception is
narrow, self-closing and audited:

- It applies only to an account whose email is in `BOOTSTRAP_SUPERADMIN_EMAILS`
  **and** which belongs to the `system` org, while `User.mfaBootstrapClosedAt` is
  unset **and** it has no factor.
- Their password sign-in opens a real session, flagged `mfaEnrollmentPending` and
  `aal: 1`, that can reach **only** enrolment, sign-out and the routes
  `init-platform.sh` calls (read the org and its roles, create the `setup`
  service account, issue and revoke its keys). Every other service refuses such a
  token outright with **403 `MFA_ENROLLMENT_REQUIRED`**; the dashboard sends them
  straight to Security → Factors.
- It **closes permanently at the first enrolment** of any factor and never
  reopens, even if that factor is later removed.
- System-org "require MFA" **cannot be turned on while it is open** — doing so
  would refuse the only account that can close it (409
  `MFA_BOOTSTRAP_STILL_OPEN`).
- **SSO enforcement never applies to a bootstrap admin.** SSO refuses
  superadmins, so a verified, SSO-enforced domain matching their address would
  otherwise close both sign-in paths.
- Every exception sign-in writes `auth.mfa.bootstrap_session` and increments
  `platform_mfa_bootstrap_session_total{late}`. A fresh install finishes in
  minutes, so `late="true"` — more than 24 hours after the system org was created
  — fires the `MfaBootstrapSessionLate` alert.

### Recovery when every factor is lost

There is **no HTTP route**. A route that removes someone's second factor is by
construction a bypass of the second factor. Recovery is an operator command run
with database access, inside a platform container:

```bash
docker compose exec platform node scripts/mfa-recover.js --email admin@internal --operator you@example.com
kubectl exec -n pipeline-builder deploy/platform -- \
  node scripts/mfa-recover.js --email admin@internal --operator you@example.com --clear-org-policy
```

It removes every passkey and the authenticator enrolment, bumps `tokenVersion`
(ending every session, everywhere) and writes `auth.mfa.operator_reset`
attributed to the named operator. It does **not** reopen the bootstrap exception.
If the person's org requires MFA they would now be unable to sign in at all, so
`--clear-org-policy` turns that org's requirement off in the same command — turn
it back on once they have re-enrolled.

**People are told this on the sign-in page**, at the two points where they hit
the dead end, so the request reaches an operator instead of a support queue:

- The **code step** names the recovery code in its copy (not only in the field's
  placeholder) and carries a folded-away **"Lost your phone and your codes?"**
  panel explaining that no self-service route exists, naming the command above
  and saying who runs it.
- A sign-in refused by the org policy (`401 MFA_REQUIRED` — the grace period has
  passed and the account has no factor) gets its own panel instead of a red
  error: the password was right and nothing they can retype will help. It points
  at the passkey button (a passkey satisfies the requirement on its own), says an
  owner or admin can lift the requirement or extend the grace period, and shows
  the recovery command for the case where the factors existed and are gone.

### What gets recorded

`auth.mfa.bootstrap_session` (every exception sign-in; `details.late`),
`auth.mfa.bootstrap_closed` (the first enrolment closed it),
`auth.mfa.operator_reset` (the recovery command) and `org.mfa_policy.update`
(both sides of the transition). Refusals are metered as
`platform_mfa_enforcement_refused_total{reason}` on platform and
`mfa_enforcement_refused_total{service,reason}` elsewhere — `reason` is
`weak_session`, `stale_session`, `machine_principal` or `bootstrap_session`.
Policy changes count in `platform_mfa_policy_changes_total{requireMfa}`.

---

## Domain-based org join (P2b)

Separate from SSO, an org can let people with a **verified company email domain**
discover and join it — so coworkers land in one org instead of many one-person
orgs. Requires the **Team or Enterprise** tier. The design and threat model are
covered in the sections below.

### Admin setup (Settings → Domain-based join)

1. **Register the domain** (e.g. `acme.com`). Public/freemail domains
   (`gmail.com`, …) are rejected.
2. **Verify ownership** — publish the shown DNS TXT record, then click Verify:
   ```
   _pipeline-builder-verify.acme.com  TXT  "pb-verify=<token>"
   ```
   The platform resolves the record (bounded timeout) and, on match, marks the
   domain verified. First org to verify a domain owns it.
3. **Choose who can join** for the verified domain:
   - **Off** — registered but not discoverable (default).
   - **Request** — matching signups may request; an admin approves in the same
     panel (Approve / Deny).
   - **Auto** — matching signups join immediately as a **member** (use only for a
     domain you fully control).

### What the joining user sees

On first sign-in, the onboarding screen shows a **"Join your team"** section
listing discoverable orgs for their verified email domain. **Auto** joins in one
click; **Request** files a request an admin reviews. Discovery is
verified-email-gated and only ever shows the user's *own* domain's orgs.

### Behavior worth knowing

- **Seats**: an auto-join or approval consumes a seat and is rejected if the
  account is at its seat cap.
- **Removed users** can't silently rejoin an `auto` domain — the join falls back
  to a request for an admin to approve.
- **Denied requests are sticky** (a user can't re-spam); an admin re-opens.
- **Turning a domain off / deleting it** denies its pending requests; deleting the
  org frees the domain for anyone to register.
- Every action is audited (`org.domain.*`, `org.join.*`).
- **Notifications**: admins get an email + an in-app inbox message (live) on a new
  request; the requester is notified (email + in-app) on approve/deny.
- **Verified domains are periodically re-checked**; if the DNS TXT proof is
  definitively removed, the domain is auto-un-verified and its join disabled.

---

## How tokens are signed (and who can sign one)

**Only platform signs tokens that speak for a person.** Access, refresh, step-up
and the short-lived token an [access key](#access-keys-opaque-verified-by-exchange)
is exchanged for are all **ES256** (ECDSA on NIST P-256), signed with a key
platform alone holds, and each carries a `kid` naming the key that signed it.

Everyone else verifies against the public halves, published unauthenticated at:

```
GET /.well-known/jwks.json      →  { "keys": [ { "kty":"EC", "crv":"P-256", "kid":"…", "use":"sig", "alg":"ES256", "x":"…", "y":"…" } ] }
```

The verifiers are every API service (through api-core's `requireAuth`), the
`pipeline-manager` CLI, image-registry's `/token` mint path, and the
pipeline-events Lambda. Each caches the key set, refreshes it every 10 minutes,
refetches **once** when it sees an unknown `kid` (which is how a rotated-in key
starts working without a restart), briefly negative-caches a failed fetch, and
**fails closed**: a token it cannot verify is answered `503` (retry), never
allowed through.

Why it matters: before this, all ten services shared one HMAC secret, so **any
one of them could mint a platform-admin token**. Now a service compromise cannot
produce a user identity at all.

| Token | Signed by | Algorithm | Verified by |
|---|---|---|---|
| access, refresh, step-up, exchanged access key | platform only | ES256 + `kid` | everyone, via the JWKS |
| internal service token (`service:<name>`) | the CALLING service, its own key | ES256 + `kid` | everyone, against the mounted public key bundle |
| image-registry's own Docker-registry tokens | image-registry | RS256 + its own keypair | the Docker registry |

The two chains are kept apart by construction, in both directions: a token
verified with a SERVICE key that claims `principalType: user` is **refused
everywhere**, and a token verified against platform's JWKS that claims
`principalType: service` is refused too. Both chains are ES256 now, so a bearer
token is routed by **who owns its `kid`** — and a `kid` is the RFC 7638
thumbprint of the key itself, so ownership is a fact about the key rather than a
claim the token makes about itself. An HS256 token is accepted by neither chain.

See [Internal service tokens](#internal-service-tokens-one-key-per-service) for
the service half.

The private key lives either in a file platform reads at boot
(`TOKEN_SIGNING_MODE=local` — a Kubernetes Secret on the cluster targets) or
inside **AWS KMS** (`TOKEN_SIGNING_MODE=kms`, an asymmetric `ECC_NIST_P256`
sign-only key), chosen by config. Platform refuses to start if it cannot load a
signing key: it is the only minter in the fleet, so there is no degraded mode
worth serving.

Rotation is by `kid` — publish the incoming key next to the retiring one, switch
signing, then stop publishing the old one. No verifier restarts, and no session
breaks. Operator steps: [Secret Rotation](runbooks/secret-rotation.md#user-token-signing-key-es256-rotated-by-kid).

### Cutover — what stops working at release

There is **no backward compatibility**: HS256 user tokens are not accepted after
this change, and nothing accepts the old shape during a window. At release:

- **Every existing session ends.** Access AND refresh tokens were signed with the
  shared secret, so every signed-in device must sign in again. There is nothing
  to migrate — a refresh with an old token is a signature failure.
- **Every step-up token dies** (they live 60 s, so this is invisible).
- **Every access key's exchanged token dies** (they live 5 minutes). The keys
  themselves are unaffected: they are opaque and stored as hashes, so the next
  exchange simply returns an ES256 token. No key needs reissuing for this change.
- **Stored machine credentials are unaffected by THIS change** — they are opaque
  [service-account keys](#stored-machine-credentials-aws), not JWTs, so a signing
  change cannot invalidate them. They do have their own one-time reissue, for a
  different reason: they used to be a person's machine-session JWT. See
  [Stored machine credentials (AWS)](#stored-machine-credentials-aws) and the
  [cutover runbook](runbooks/access-key-cutover.md#machine-credentials-the-service-account-cutover).

Operator checklist for the deploy itself:

1. Generate the signing key **before** starting platform —
   `deploy/bin/token-signing-keys.sh <target>/certs` on the local targets, or
   create the KMS key and set `TOKEN_SIGNING_MODE=kms` +
   `TOKEN_SIGNING_KMS_KEY_ID`. Platform refuses to start without one.
2. `REFRESH_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET_PREVIOUS` are **gone** — remove
   them from `.env`. Nothing reads them; a refresh token is a user token now.
3. `JWT_SECRET` is **gone**, along with `JWT_SECRET_PREVIOUS` and
   `JWT_ALGORITHM` — remove them from `.env`. Internal service tokens are ES256
   per service now; generate the keys with `deploy/bin/service-signing-keys.sh`
   BEFORE starting any service, and deploy every service together (see
   [Internal service tokens](#internal-service-tokens-one-key-per-service)).
4. The gateway no longer receives a signing secret: `deploy/*/nginx/jwt.js` decodes
   claims for the access log and the `x-org-id` / `x-user-id` hints and verifies
   nothing (ES256 verification needs an async JWKS fetch, which a synchronous
   njs `js_set` handler cannot make). Nothing is lost that was enforcing: the
   gateway never rejected a request, and each service re-derives the request's
   tenant identity from the token it verified itself. The anti-spoof property
   also survives — nginx still OVERWRITES those headers on every proxied request,
   so a client cannot inject an org id of its choosing.
5. Check `GET /.well-known/jwks.json` through the gateway before announcing the
   deploy done: every verifier depends on it, and a target whose nginx does not
   proxy that path cannot verify any token.

## Internal service tokens (one key per service)

Inter-service calls (billing → message, platform → compliance, every service →
quota's usage counters) carry their own token, minted by `signServiceToken` with
`principalType: 'service'` and `sub: service:<name>`, and living 5 minutes.

Each service signs those with **its own ES256 key**. Before this, all ten shared
one `JWT_SECRET`, which meant any service could mint a token naming any other —
"billing said so" was unfalsifiable, and one compromised workload spoke for the
whole fleet. Now:

- the token's `kid` is the thumbprint of the signing key, and the verifier looks
  the key up by that `kid`, which also tells it **which service owns it**;
- the token's `sub` must name that same service, so a token signed by compliance
  claiming to be billing is a forgery, not a valid token with a confusing
  subject;
- a service that captures another's token can still replay it inside its 5-minute
  life — what it cannot do is mint one.

**Public keys are distributed by config, not by per-service JWKS endpoints.** The
deploy generates a keypair per service, mounts each private key into only that
service, and mounts one public bundle everywhere:

| Variable | Holds |
|---|---|
| `SERVICE_SIGNING_KEY_FILE` | this service's EC P-256 private key (PKCS#8 PEM). Per service. |
| `SERVICE_KEY_BUNDLE_FILE` | `{"services": {"<name>": {"keys": [<jwk>…]}}}` — every service's public keys. Identical everywhere; public. |

Three properties decided that over an HTTP key set per service:

1. **`verifyServicePrincipal` stays synchronous.** The global rate limiter's
   `skip` and the `/warmup` guard verify a service token *before* `requireAuth`
   runs, in synchronous Express callbacks; an HTTP fetch would make them async.
2. **No availability coupling.** Fetching billing's keys from billing would mean
   billing being down stops platform accepting billing's in-flight calls —
   turning one outage into several.
3. **No N×N address config**, including under docker compose, which has no mesh
   and no service discovery beyond DNS.

`deploy/bin/service-signing-keys.sh` generates and rotates both halves; a service
refuses to start without them. Rotation is by `kid`, two-phase, and needs no
coordinated restart: [Secret Rotation](runbooks/secret-rotation.md#internal-service-signing-keys-es256-per-service).

### Internal routes

A handful of routes exist ONLY for service-to-service calls — `/internal/*`, the
quota usage counters, the entity-event and audit ingests, and the billing→
compliance / billing→reporting entitlement legs. They go through one shared gate,
`requireInternalService({ callers: [...] })`, which:

- **refuses every user token outright** — not a member's, not a superadmin's, not
  an access key's. "A sufficiently privileged human" is not an acceptable caller
  for a peer-service API; that equivalence is how a browser-reachable path
  becomes a tenant-boundary bug. (This replaced several `|| isSystemAdmin(req)`
  escape hatches that had grown around the individual routes.)
- **admits only the named callers**, and since the name is bound to the signing
  key this is an identity check rather than a claim check.

Refusals increment `internal_route_refused_total{service,route,reason,caller}`
(`reason` is `unauthenticated`, `user_token` or `wrong_caller`) and are written to
the audit trail as `authz.denied`.

Each service's route-coverage test declares its internal routes and their callers
and checks the declaration against the code in both directions, and any route
whose path contains `/internal/` must carry the gate — with no exception list.

On minikube, EC2 and EKS an Istio `AuthorizationPolicy` per internal route names
the same calling service accounts, as a second, independent refusal
(`deploy/*/k8s/istio-internal-routes.yaml`). It is defence in depth, never the
enforcement: docker compose runs no mesh at all, so the token check has to hold
on its own there — which
`packages/api-core/test/internal-route-mesh-less.test.ts` proves by running the
mesh-less configuration against a real HTTP server and real keys.

## Token claims (what a request proves)

Every access token carries an explicit identity, so an auth decision never has to
infer one from the shape of a token:

| Claim | Values | Meaning |
|-------|--------|---------|
| `principalType` | `user`, `service_account`, `service` | Who the token speaks for. `service` is an internal Pipeline Builder service (`signServiceToken`); `service_account` is an [org service account](#service-accounts) — a non-human principal owned by one org. |
| `token_use` | `access`, `api_key` | `access` is a session token (interactive, machine session, or service); `api_key` is the short-lived token an [access key](#access-keys-opaque-verified-by-exchange) was exchanged for — its `jti` is the key's id. |
| `amr` | `pwd`, `oauth`, `sso`, `webauthn`, `stepup`, `mfa` | How the person authenticated. `webauthn` is a passkey assertion with user verification. `mfa` says a second factor was presented as well — an authenticator-app code or one of its recovery codes — so it appears ALONGSIDE the method that identified the user (`['pwd', 'mfa']`), never on its own. |
| `aal` | `1` | Assurance level. Always `1` today — assurance levels (and the `2` a passkey or password+TOTP earns) are a separate change; no route requires one yet, which is why a TOTP sign-in raises `amr` but not this. |
| `auth_time` | epoch seconds | When the sign-in behind the session happened. |
| `scope` | e.g. `reporting:ingest` | A narrow machine capability; a scoped token is minted least-privilege (member role, no features, no permissions). |

`amr`, `aal` and `auth_time` are stored on the refresh-session slot, so a refresh,
a machine-credential renewal and an org switch all reproduce them **unchanged** —
none of those can raise the assurance level or make a sign-in look fresher than it
was. An access key stores the creating session's values on its record, and an
impersonation session inherits the operator's, so neither can raise assurance.

Services reject a token that lacks these claims (an unknown `principalType`, a
user principal with no assurance claims, a `service` principal whose subject
doesn't name a service). There is no legacy shape: **every token minted before
this release stops working at release** — sessions re-authenticate, and stored
machine credentials must be re-issued (see below). Personal access tokens are
gone entirely; they are replaced by access keys.

## Access keys (opaque, verified by exchange)

A CLI, CI job or integration authenticates with an **access key**, not a JWT:

```
pb_pat_Xy3kQ0…            a person's key (43 base64url chars of CSPRNG output)
pb_sa_Ab1cD2…             an org SERVICE ACCOUNT's key (see below)
```

The key is **opaque**: it carries no claims and no signature, so nothing can be
read out of it and nothing can verify it locally. Platform stores only
`sha256(key)` plus the prefix and last four characters, which is all the UI can
ever show (`pb_pat_…a1b2`). **The key itself is displayed exactly once**, in the
create response — there is no way to recover it afterwards.

### How a request with a key is authenticated

```
caller ──Authorization: Bearer pb_pat_…──▶ any service
                                            │
                       POST /auth/token/exchange  (once per 5 minutes, cached)
                                            ▼
                                        platform ──▶ 5-minute JWT (token_use: api_key)
                                            │
                          every service then verifies that JWT as usual
```

Only platform, billing and quota have MongoDB, so the other services cannot look
up a key hash — and asking platform on *every* request would put it on the hot
path of the whole fleet. Instead api-core exchanges the key **once** and caches
the returned JWT in-process until it expires, re-exchanging early (at ~75 % of
its life, jittered ±10 %) so no request ever blocks on the exchange and a fleet
of pods doesn't stampede platform together. Concurrent requests for one key share
a single round-trip, and a key platform refused is remembered for 30 s.

Platform itself skips the round trip: it owns the collection, so a key presented
straight to it is resolved in place — through the same service, producing the
same claims.

What this buys, and what it costs:

- **Revocation works everywhere.** A revoked key can no longer be exchanged, so
  it stops working on every service within one token lifetime (5 minutes). The
  old JWT PAT was only checked at platform and kept working elsewhere for up to
  365 days.
- **Claims are never stale.** Role, permissions, tier, features and `isSuperAdmin`
  are re-derived from the user and their membership on *every* exchange, so a
  demotion reaches the key in the same 5 minutes. A JWT PAT baked them at mint.
- **Accurate last-used.** The exchange is what stamps `lastUsedAt`, so the keys
  page is right no matter which service the key was actually used against.
- **Platform down is a 503, not a pass.** A service that cannot reach platform
  answers `503 SERVICE_UNAVAILABLE` and increments
  `api_key_exchange_failures_total{reason="unavailable"}`. An unverifiable
  credential is not an identity, so this path deliberately does **not** fail open.

### The exchange endpoint

`POST /auth/token/exchange` with `{ "key": "pb_pat_…" }` returns
`{ accessToken, expiresIn, keyId }`. It is pre-auth by construction (the key *is*
the credential, exactly as the password is on `/auth/login`) and is rate-limited
twice: per presented key (60/min, keyed on the key's hash — never the key) and
per client IP (300/min, skipped for a verified internal service principal, since
one service pod exchanges on behalf of many keys). Both outcomes are audited —
`user.key.exchange` names the key and its owner, `user.key.exchange.failed`
records *why* it was refused. The response never differentiates: unknown,
revoked, expired and "the org went away" all answer the same 401, so the endpoint
can't be used to tell a real key id from a guess.

### Managing keys

**Dashboard → Security → Access keys** lists every key with its scope, expiry,
last use and where it was created, and flags the two things an access review
actually asks about: a key that has **never been used** and one **expiring within
14 days**. Creating a key is step-up gated (minting a durable bearer credential
is at least as sensitive as changing a password, and step-up also stops
key-chaining: a key can't produce the step-up token a new key needs). Revoking is
immediate and irreversible.

The CLI mints one with `pipeline-manager auth pat --name <name>` — a browser
sign-in whose approval supplies the step-up, so no password is typed; the printed
key is what `PLATFORM_TOKEN` expects. `POST /user/tokens/revoke-all` ("Sign out
everywhere") revokes every key the user holds, as does deleting the account.

> **At release — no backward compatibility.** Every existing personal access
> token stops working: they were JWTs, and JWT PATs are gone. **Announce the
> cutover first**, then have each holder re-issue their credential from the keys
> page (or `pipeline-manager auth pat`) and update wherever it is stored. See the
> [Access key cutover runbook](runbooks/access-key-cutover.md) for the operator
> checklist, including the AWS Secrets Manager entries.

## Service accounts

A **service account** is a non-human principal owned by ONE organization. It has
no password, no email sign-in and no sessions: it authenticates only with
`pb_sa_…` keys, traded at the very same `POST /auth/token/exchange` endpoint a
personal key uses, for a 5-minute token carrying `principalType:
'service_account'` and `token_use: 'api_key'`.

Use one wherever automation currently runs as a person — CI, deploy hooks,
ingest, the setup scripts. The point is that it does not belong to anyone:

| Rule | What it means in practice |
|------|---------------------------|
| **Org-owned, never orphaned** | The creator is recorded for attribution only. When they leave, the account keeps working; only the org purge deletes it (with every key). |
| **Roles, through the same machinery** | It holds the org's Roles via `role_assignments`, and the assignment ceiling is identical: you can never create an account more powerful than yourself. Only a platform superadmin may grant a `superadmin`-granting Role. |
| **Never impersonated** | Impersonation acts on user accounts; a service account has no user record to assume. |
| **SSO enforcement does not apply** | SSO governs how PEOPLE sign in. A service account never signs in, so an org's SSO requirement neither blocks nor covers it — revoke its keys to cut it off. |
| **Never satisfies assurance** | Its token carries `amr: []` and `aal: 1`, and `requireStepUp` refuses the principal outright — so a key can never be used to mint another key, delete an org, or pass any human-presence gate. |
| **No seat** | Seats count distinct active humans. A service account creates no membership row, so it consumes none — adding accounts never costs a seat. |
| **Its own quota** | Each account has a per-period **token-exchange budget** (`QUOTA_RESET_DAYS`, unlimited by default). Every exchange consumes one unit, metered atomically, so runaway automation is bounded on the account's own budget instead of draining the org's API quota. Entity quotas (pipelines, plugins) still belong to the org that owns the created entity. |
| **Keys expire, and are capped** | At most 5 active keys per account, each at most 365 days, with an optional per-key IP allowlist. |
| **Rate-limited per account** | Platform buckets an account's traffic under its own key (`sa:<id>`, or the presented key's hash pre-auth), and `rateLimitByOrg` does the same, so one noisy account cannot exhaust the window its org's people share. |

Creation and key management live at **Dashboard → Settings → Service Accounts**.
Every route — the listing included — requires `service_accounts:manage`, and
every write is **step-up gated** exactly like creating a personal access key
(revoking a key is not, so a compromised credential can be killed immediately). The keys also appear on **Dashboard → API
Tokens**, in the same list as personal keys, labelled with their owning account.

### The IP allowlist, precisely

A key's allowlist is enforced **at the exchange**, against the address platform
sees for that request:

- a key presented **straight to platform** (the CLI, `curl`, the deploy scripts)
  is checked against the caller's own address — `req.ip`, i.e. what the ingress
  reports, not a client-supplied header;
- a key presented to **another service** is exchanged by that service, so the
  address platform sees is the calling pod's. Treat the allowlist as a perimeter
  control for credentials used against platform, not as a per-service one.

An allowlist that is set but cannot be evaluated (no address, an unparseable one)
**denies** — the control exists to bind a key to known addresses, so "couldn't
tell" must not pass.

### Setup automation uses one

`deploy/bin/init-platform.sh` registers the bootstrap admin, signs in **once**,
and then creates a system-org service account named `setup` with a single 24-hour
key. The plugin, template and compliance loads run with that key instead of
re-running `login` with the admin password between steps. Consequences worth
knowing:

- the admin's password is used exactly twice (register, sign-in + the two step-up
  confirmations) and never leaves the script;
- the key expires by itself in 24 hours, so a half-finished install leaves no
  durable credential behind;
- the load steps are audited as the `setup` account, not as a person;
- re-running init is idempotent: the existing `setup` account is reused and its
  previous keys are revoked before the new one is issued, so the 5-key cap can
  never fail a re-run. Override the lifetime with `SETUP_KEY_TTL_SECONDS`.

### Scoped keys — one capability, no Roles

A key may carry a **capability scope** instead of the account's Roles. The
exchanged token then has `scope` set, `permissions: []`, `role: 'member'` and no
admin flags at all, whatever the account itself holds. That is the shape every
automation which does exactly one thing should hold:

| Scope | What it can do | Who holds one |
|---|---|---|
| `reporting:ingest` | `POST /reports/events`, `/reports/ingest-health`, `/reports/incidents` | the AWS event-ingestion Lambda; the incident webhook |
| `registry:push` | `docker pull`/`push` inside the owning org's `org-{id}/*` namespace, through image-registry's `/token` | CodeBuild's registry credentials; any CI that pushes images |
| `scim` | the whole `/scim/v2` surface — provision, update and deactivate members of the owning org, and move them between directory groups | an identity provider's SCIM client (see [SCIM 2.0 provisioning](#scim-20-provisioning)) |

The scope is checked by the consuming route (`hasScope`, a single-value equality
check), so a token carrying one scope can never satisfy another, and an
**unscoped** key — even one on an account holding the org admin Role — satisfies
none of them. `registry:push` grants the raw-image write that `plugins:write`
grants a person, and nothing else: the namespace rules in image-registry key off
`organizationId` and `isSuperAdmin`, neither of which a scoped mint can raise, so
a leaked push credential reaches its own org's namespace and stops there.

Set it when the key is issued:

```http
POST /organization/{orgId}/service-accounts/{accountId}/keys
{ "name": "ci-push", "expiresIn": 2592000, "scope": "registry:push" }
```

The valid values are api-core's closed `TOKEN_SCOPES` catalog — one list, shared
by every mint path, so an unknown scope is a `400`, never a silently unenforced
credential.

### Self-rotation — how an unattended machine replaces its own key

Every key write on the org routes is step-up gated, and a service account can
never step up (`amr: []`). A machine with no password therefore cannot rotate its
own credential through those routes at all. Two pre-auth endpoints exist for
exactly that, where the **key itself is the authorization**:

| Route | Body | Effect |
|---|---|---|
| `POST /auth/key/rotate` | `{ key, name?, expiresIn? }` | Mints a **sibling** key on the same account, inheriting the presented key's scope, IP allowlist and (by default) its original lifetime. The presented key stays **live**. |
| `POST /auth/key/revoke` | `{ key, keyId }` | Retires a sibling key, authenticated with the one that replaced it. |

Both run the same gates as an exchange (account enabled, org live, address inside
the allowlist, budget available), share its two rate limiters, and are audited as
`org.service-account.key.rotate` / `.revoke` attributed to the **account**.

Two rules make the whole thing safe, and they are the reason the ordering works:

- **A key may never revoke itself here** (`400 SELF_REVOKE_REFUSED`). The rotator
  can therefore not destroy the credential it is holding.
- **Only a `pb_sa_` key may rotate.** A person's key is managed in the UI behind
  step-up; letting one rotate itself would be a step-up bypass.

The caller's order is **rotate → store → revoke**, and every failure leaves a
working credential:

| Fails at | What survives |
|---|---|
| rotate | The secret is untouched; the current key is still live. |
| store | The secret still names the current key, which is still live. The new key is an orphan that expires on its own. |
| revoke | Both keys work. The credential is healthy; the stale key expires on its own. |

Revoke-then-create would invert all three. If an earlier rotation never revoked
its predecessor, the account drifts towards its 5-key cap — so `rotate` retires
the **oldest** active sibling (never the presented key) when it is at the cap, and
reports what it pruned in `prunedKeyIds`.

### Stored machine credentials (AWS)

`pipeline-manager infra store-token` provisions the org's machine identity and
parks a key in AWS Secrets Manager. It creates (or reuses) the service account,
issues one key, writes the secret, and only then retires the key the previous run
stored:

| Secret | Account | Roles | Key scope | Read by |
|---|---|---|---|---|
| `pipeline-builder/{orgId}/platform` | `platform-automation` | org admin | none | CDK synth/deploy callbacks (`--store-tokens`), the plugin-lookup Lambda |
| `pipeline-builder/{orgId}/registry-push` | `registry-push` | none | `registry:push` | CodeBuild's `secretsManagerCredentials` (Basic auth to image-registry) |
| `pipeline-builder/{orgId}/reporting-ingest` | `reporting-ingest` | none | `reporting:ingest` | the event-ingestion Lambda |

The secret's schema is unchanged in shape — `{ username, password, platformUrl, … }`
— and `password` is still the canonical field. What changed is its VALUE: a
`pb_sa_…` key instead of a JWT. Nothing downstream verifies it, because there is
nothing in an opaque key to verify: image-registry and every service exchange it
(api-core's cached exchange client), and the events Lambda exchanges it itself.
The secret additionally records `keyId`, `serviceAccountId` and `scope`, which is
what the rotation Lambda needs to retire the key it replaces.

Because creating an account and issuing a key are step-up gated, `store-token`
needs the operator's password — `PLATFORM_PASSWORD` (preferred) or `--password`.
`--schedule` installs the daily rotation stack described above.

## CLI sign-in by device authorization (RFC 8628)

`pipeline-manager auth login` has no password flag, and there is no way to hand
the CLI a refresh token. It signs in with the OAuth 2.0 **device authorization
grant** instead:

1. `POST /auth/device/code` — the CLI asks for a code. It gets back a
   `device_code` (256 bits of randomness, the credential it will redeem), a short
   `user_code` (`BCDF-GHJK`), `verification_uri`, `verification_uri_complete`,
   `expires_in` (10 minutes) and `interval` (5 seconds).
2. The CLI prints the code and the URL, and opens a browser when it can (never
   under `CI`, over SSH, or with `--no-browser`).
3. The person signs in **in the browser** if they are not already, sees *which*
   device is asking (its client summary and IP, its code, when it expires), and
   confirms. Approving is **step-up gated**, so it is factor-agnostic: a
   password, a provider re-auth for a social/SSO account, and later a passkey or
   TOTP all satisfy it. Whatever the org enforces for the browser — SSO, MFA —
   already applies, because this *is* a browser session.
4. `POST /auth/device/token` — the CLI polls. Until the person decides it gets
   the RFC's `authorization_pending`; polling faster than the interval gets
   `slow_down` (and the interval widens by 5 seconds, permanently for that
   flow); a refusal gets `access_denied`; a lapsed, over-polled or
   already-redeemed code gets `expired_token`.
5. On approval the poll returns the session, and the flow is **consumed** — the
   device code cannot be redeemed twice.

**Why the CLI ends up with a normal session.** The approved session is an
ordinary `interactive` refresh session, opened through the same `issueTokens`
path as a browser login, carrying the *requesting device's* client summary and
IP. It therefore appears under **Settings → Sessions and devices** as
"pipeline-manager CLI on macOS" and is signed out from there like any other
device. It **inherits** the approving session's `amr`, `aal` and `auth_time`
verbatim — approving on a second device can never raise assurance or reset the
sign-in time.

**State and abuse resistance.** The two entries live in the shared Redis
pending-state store, so the pod that mints a code, the pod that serves the
approval page and the pod that answers the poll need not be the same one. The
record is keyed by the **hash** of the device code, never the code. The
`user_code` is drawn from a 20-character alphabet with no vowels and no
look-alikes (`BCDFGHJKLMNPQRSTVWXZ`) — 20⁸ ≈ 2.6 × 10¹⁰ combinations, alive for
10 minutes. The poll is limited per device code (30/min, keyed on its hash) and
per IP (300/min), and each code has a hard ceiling of 200 polls; the browser
endpoints are limited **per signed-in user** (15/min), which is what bounds
guessing the short code. `/auth/device/*` is mounted ahead of `/auth` so it never
shares the strict pre-auth bucket, and the poll is exempt from the general
limiter — a conforming client legitimately sends ~120 requests per sign-in.

**Audit.** `device.authorize.start` (pre-auth, actor `anonymous`, with the
requesting device in `details`), `device.authorize.approve`,
`device.authorize.deny` and `device.authorize.expire`. All four carry the flow's
correlation handle as `targetId` — a truncated hash of the device code, so the
trail joins up without recording either live code. The metric is
`platform_device_authorizations_total{result}`.

**`auth pat` uses the same flow.** Creating an access key is step-up gated
server-side, which used to force the CLI to hold a password and POST it twice
(sign-in, then step-up). Now the CLI sets `step_up: true` on `/auth/device/code`,
the browser approval supplies the step-up, and the approved poll returns a
short-lived `step_up_token` alongside the session — spent immediately on
`POST /user/keys`. No password is typed into a terminal at any point.

**Where the session is kept.** `~/.pipeline-manager/credentials.json`,
owner-only (`0600` inside the `0700` directory), keyed by platform base URL so
one workstation can hold sessions for several platforms. `PLATFORM_TOKEN` always
takes precedence, which is what CI sets to an access key.

> **At release — no backward compatibility.** `auth login -u/-p` and
> `auth login --refresh <token>` are **gone**, not deprecated. Scripts that used
> either must move to an access key (`auth pat`, exported as `PLATFORM_TOKEN`) —
> which is what they should have used anyway, since a session token expires in
> minutes. `init-platform.sh` and `infra provision --admin-password` still
> register and log in the bootstrap admin with a password over `curl`: that is a
> genuinely non-interactive first-boot step with no browser to approve anything
> in, and it is the *only* password path left.

## Where the refresh token lives

The refresh token is a 30-day credential. It is delivered over one of two
transports, chosen by a single explicit signal — the **`X-Pb-Client`** request
header:

| Caller | Sends | Receives the refresh token as | Presents it as |
|--------|-------|-------------------------------|----------------|
| Browser app | `X-Pb-Client: web` | `Set-Cookie: pb_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh` — **never** in the response body | the cookie, attached automatically |
| CLI / CI / scripts | `X-Pb-Client: cli` (any value but `web`) | `refreshToken` in the JSON body | `{"refreshToken": "…"}` in the request body |

The CLI receives its pair from the device-authorization poll above and keeps it
in its own credential store; it never accepts one typed on a command line.

The browser's access token is held **in memory only** — there is no
`localStorage` copy of either token. A page reload therefore starts with no
access token and silently trades the cookie for a new one
(`ApiCore.restoreSession()`); a non-secret `pb.session` marker in `localStorage`
records only *that* a session exists, so an anonymous visitor isn't made to
probe the refresh endpoint. An XSS that runs in the page can no longer walk off
with a 30-day credential; the worst it can reach is a 15-minute access token.

Because the cookie is ambient authority, `POST /auth/refresh` and
`POST /auth/logout` **refuse any request without the `X-Pb-Client` header**
(403 `CLIENT_TYPE_REQUIRED`). A cross-site form, image or navigation cannot set
a custom header, and a cross-origin `fetch` that tries triggers a preflight
CORS refuses — so a foreign page cannot spend the cookie. The requirement is
unconditional, including for CLI callers, so that it cannot be stripped.

Both transports are read by `POST /auth/refresh`; when a request carries **both**
a cookie and a body token, the cookie wins — a browser must not be talked into
refreshing a token some injected script supplied. Every endpoint that issues a
session (login, the OAuth and SSO callbacks, `switch-org`, `tokens/revoke-all`)
uses the same split; logout, `/auth/refresh`'s rejection and account deletion all
clear the cookie, because only the server can.

Cross-tab: tabs can no longer read the refresh token, so they coordinate over a
`BroadcastChannel` (`pipeline-builder:auth`) plus the existing Web Lock. The
tab that wins the lock refreshes and **broadcasts the new access token**; the
others adopt it instead of rotating the shared cookie again. A sign-out in one
tab is broadcast too. The Web Lock is load-bearing: it guarantees a sibling's
`Set-Cookie` has landed before the next tab presents the cookie, so two tabs
refreshing together can never both send the pre-rotation token (which the server
would read as reuse and answer by revoking the slot).

> **At release**: sessions opened before this change simply **stop refreshing** —
> their refresh token was in `localStorage`, which is no longer read, and no
> cookie exists for them. Users sign in again once. There is no migration.
>
> **Operators**: the cookie is same-origin only — the UI and the API must be
> served from one origin (they are: the browser calls `/api/...` on the gateway
> that fronts both), and `PLATFORM_FRONTEND_URL` must name that origin so CORS
> and the OAuth callbacks agree. nginx passes `Cookie`/`Set-Cookie` through
> untouched on every shipped target and needs no `proxy_cookie_path`: the
> platform stamps the **public** path (`/api/auth/refresh`) even though nginx
> strips `/api` before proxying. `Secure` is set by default and every target
> terminates TLS in front of the gateway (docker and minikube on `:8443`, EC2 and
> EKS at the load balancer); browsers also accept `Secure` on `http://localhost`.
> Only a plain-http deployment on a non-localhost hostname needs
> `AUTH_COOKIE_SECURE=false`, and `AUTH_REFRESH_COOKIE_PATH` only if the UI is
> served under a different public prefix.

## Sessions, devices and machine credentials

> **Where these live.** Everything that can sign in as you — password, passkeys,
> authenticator app, sessions and access keys — is on **Dashboard → Security**,
> in four tabs (Factors · Sessions · Access keys · Service accounts). It replaces
> Settings → Security, the "API Tokens" page (which carried a second, conflicting
> sessions list) and Settings → Service Accounts. The old addresses forward to the
> matching tab, so saved links and CLI docs still land; nothing of the old pages
> runs behind them.


**Dashboard → Security → Sessions** lists the account's live sessions. Each refresh-session
slot records a short client summary derived from the User-Agent ("Chrome on
macOS" — no raw header, no versions) and the last IP it was used from. IPs are
personal data: they live only as long as the slot, are dropped when the slot or
the user is deleted, and are never geolocated.

Sessions come in two kinds:

- **Interactive** — a signed-in device (password, social, SSO). Renewed by
  `POST /auth/refresh`; at most 10 per user, the oldest dropped when an 11th
  signs in. Signing one out ends that device only.
- **Machine** — a stored credential minted by `POST /user/generate-token`.
  Renewed **only** through `generate-token` (a machine session is refused by
  `POST /auth/refresh`, which is what stops an operator's own CLI refresh from
  tripping reuse detection on a production credential). At most 10 per user, the
  **least recently used** dropped first, so a credential renewed daily is never
  evicted and abandoned ones are.

  > **Not what stored credentials use any more.** `pipeline-manager infra
  > store-token`, the AWS rotation Lambda and CI all hold
  > [service-account keys](#stored-machine-credentials-aws) now — a machine
  > session was still a *person's* credential, and that is the thing #12 / #N2
  > removed. A machine session is what remains for a person who deliberately wants
  > a long-lived token of their own.

`generate-token` from a person (an interactive session, or a PAT with no session
at all) opens a **new** machine session holding the requested scope, leaving the
caller's own login untouched. Called with a machine token, it renews that session
in place under the scope stored on the slot — a machine session can never open
another one, and a scoped credential can never re-mint itself unscoped, under a
different scope, or as a browser session. Two `store-token` runs from one login
therefore produce two independent credentials with their own scopes.

`GET /user/sessions` / `DELETE /user/sessions/:id` back the page. The session
making the request is marked and cannot revoke itself (that is
`POST /auth/logout`); revoking is step-up gated, and every revocation is audited
as `user.session.revoke`. Revoking a machine session **stops its renewal** — the
token it last minted keeps working until it expires, so use "Sign out everywhere"
(a `tokenVersion` bump, which ends every session of both kinds and revokes the
user's access keys) when a credential must die now.

> **Operators, at release**: every stored machine credential is reissued as a
> service-account key — see [Stored machine credentials
> (AWS)](#stored-machine-credentials-aws) and the
> [cutover runbook](runbooks/access-key-cutover.md). Personal access tokens are
> access keys as well. The secret never stores a refresh token, so consumers read
> `password` — which now holds a `pb_sa_…` key rather than a JWT.

---

## See also

- [Environment Variables → Authentication](environment-variables.md#authentication) — every `OAUTH_*` and `WEBAUTHN_*` variable.
- [Roles & Permissions](permissions.md) — the `org:idp`/`org:kms` capabilities, sessions, and `tokenVersion` invalidation.
- [Billing Add-on Bundles](billing-bundles.md) — the `sso` add-on bundle and feature entitlements.
- [Audit Events](audit-events.md) — SSO/IdP config change actions, `user.step-up`, `user.passkey.*`, `user.key.*`, `device.authorize.*`.
- [Access key cutover](runbooks/access-key-cutover.md) — the one-time reissue every deployment performs at this release.
