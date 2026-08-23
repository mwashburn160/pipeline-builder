---
layout: default
title: Authentication & SSO
image: /assets/og-image-solution.png
---

# Authentication & SSO

Pipeline Builder supports three ways to sign in, side by side:

1. **Email + password** — the always-on baseline (JWT sessions, short-TTL
   access tokens + `tokenVersion` invalidation; see [Roles & Permissions](permissions.md)).
2. **OAuth social login** — platform-wide "Sign in with…" buttons for Google,
   GitHub, Facebook, Microsoft, GitLab, and LinkedIn. Configured once per
   deployment through environment variables; each provider appears only when its
   credentials are set.
3. **Per-org enterprise SSO (OIDC)** — an organization brings its own identity
   provider (Okta, Microsoft Entra ID, AWS Cognito, Auth0, …). Configured
   per-org in the app, not by env, and gated on the `sso` entitlement.

The first two are **global**: one app registration per provider, shared by
every organization on the deployment. The third is **per-organization**: each
org registers its own IdP and can force its users through it.

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
2. **Email already registered** — a user with the same (provider-verified) email exists → the provider is **linked to that existing account** and they're logged in. This is how signing in with, say, Facebook later attaches to the account first created with Google under the same email — **no second organization is created**.
3. **Brand-new identity → auto-provision.** A new `User` is created (marked email-verified, since the provider verified it), and in a single transaction the platform also creates:
   - a **personal organization**, **named after the derived username** (from the provider's display name, else the email local-part — lowercased, stripped to `[a-z0-9_-]`, length-capped, and made unique);
   - an **owner** membership for the new user;
   - the default **Admin/Member roles** — identical to what email registration seeds.

So a first-time "Sign in with Google/Facebook" **silently creates and owns a new
org**. A few consequences worth knowing:

- **No "name your organization" step.** Unlike email/password registration (which
  accepts an `organizationName`), the OAuth path derives the org name from the
  username with no prompt — e.g. a Facebook profile "Jane Doe" yields an org named
  `janedoe`. Rename it afterward in org settings if needed.
- **Tier.** The new org takes the default quota tier and is **not** provisioned to
  a paid tier until billing does so (no free paid-tier grant).
- **Facebook needs email.** Facebook only returns an email if the user grants the
  `email` scope; if they decline, sign-in fails with `OAUTH_NO_EMAIL` and **no
  account or org is created**.
- **SSO enforcement still applies.** If the email's domain is covered by an
  enabled, `sso`-entitled org IdP, the social grant is rejected with
  `SSO_REQUIRED` (see [enforcement](#per-org-enterprise-sso-oidc)) rather than
  creating a personal org — the user is routed through their org's IdP instead.

### Providers reachable via generic OIDC

**Apple, X (Twitter), Amazon, Discord, and Slack** are **not** named social-login
buttons today. Where they are OIDC-compliant they can be wired up as a per-org
enterprise SSO provider through **generic OIDC** (below). A native
**Sign in with Apple** button is a planned future addition — it needs an ES256
signed-JWT client secret and a `form_post` callback, so it lands as a dedicated
effort rather than a standard OAuth handler.

---

## Per-org enterprise SSO (OIDC)

An organization can register its **own** identity provider so its users sign in
through corporate SSO instead of a password. This is configured **per
organization inside the app** — never through environment variables — and is
stored as an `OrgIdpConfig` (one config per org).

### How it works

- **Per-org credentials.** Each org supplies its own OIDC `clientId` /
  `clientSecret`. The client secret is encrypted at rest (per-org HKDF-derived
  key + AES-256-GCM) and is never returned in plaintext by the config API.
- **Discovery + JWKS-validated `id_token`.** The login flow reads the IdP's
  OIDC discovery document (`/.well-known/openid-configuration`), exchanges the
  authorization code, and validates the returned `id_token` signature against
  the IdP's published JWKS before trusting any identity claim.
- **Domain gating that forces SSO.** `allowedEmailDomains` pins an org to one or
  more email domains. When set, users in those domains are **turned away from
  password login and routed through SSO** — and only IdP users whose email
  matches an allowed domain may sign in to that org (so an over-broad corporate
  IdP can't let `evil-contractor.com` in through your `acme.com` config).
- **`sso` entitlement.** SSO is a tier/bundle feature. It enforces only when the
  org's config is `enabled` **and** the org is `sso`-entitled (Team / Enterprise
  tier, or the `sso` add-on bundle). Entitlements pool at the account root, so a
  team reads its root's entitlement. A disabled or unentitled config is a no-op:
  password login keeps working and the SSO routes refuse — a half-configured or
  downgraded org never locks its users out.

The login-page endpoint `POST /auth/sso/discover` tells the client whether a
given email is forced through SSO — it returns only `{ sso: boolean }` and
deliberately does **not** leak the internal `orgId` or provider (it is
unauthenticated, so returning those would make it a tenant-enumeration oracle);
the org handle needed to initiate is delivered through the authenticated
`SSO_REQUIRED` login rejection instead. `GET /auth/sso/:orgId/authorize` returns
the IdP redirect URL; `POST /auth/sso/:orgId/callback` exchanges the code and
validates the `id_token`.

**Social login also honors SSO enforcement.** A user in an SSO-enforced domain
cannot bypass their org's IdP by using "Sign in with Google/GitHub/…" — the
OAuth callback runs the same enforcement check as password login and rejects
with `SSO_REQUIRED`.

> **Multi-replica:** the OAuth/SSO CSRF `state` + OIDC `nonce` are held in the
> shared Redis, so the `authorize` and `callback` requests can land on different
> replicas. Without Redis they fall back to per-pod memory (single-replica only).

### Supported IdP providers

SSO providers are the OIDC-capable set (deliberately narrower than the social-login
list — a standards-OIDC `id_token` flow is required):

- **`generic-oidc`** — any OIDC issuer with a discovery URL. Covers **Okta,
  Microsoft Entra ID, Auth0, Ping, OneLogin, Keycloak, and AWS IAM Identity
  Center**, plus any other compliant issuer (this is also the path for
  Apple / X / Amazon / Discord / Slack where they are OIDC-compliant).
- **`cognito`** — **AWS Cognito** as a named provider. The admin supplies the
  **region** + **userPoolId** and the discovery URL is **derived**
  (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration`) —
  no hand-entered URL. (A Cognito user-pool id is **not** an AWS account id and
  is safe to store.)

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

#### Google Workspace (google)

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

> After saving, set `allowedEmailDomains` to force those domains through SSO, flip
> `enabled: true`, and confirm the org is `sso`-entitled. Secret-bearing writes
> require step-up re-authentication on both config surfaces.

### Two config surfaces

The same `OrgIdpConfig` is manageable from two places, which stay in lockstep
(shared service, quota reservation, and audit actions):

| Surface | Who | Where |
|---------|-----|-------|
| **Superadmin / fleet** | Platform operators (Super Admin) | `/admin/org-idp` — register or edit SSO for **any** org on their behalf (the "IdP / SSO" dashboard page). |
| **Org-admin self-service** | An org's own admin | Managed under the org's settings, gated on the `org:idp` capability — the customer's admin configures their own org's SSO without an operator (`GET`/`PUT`/`PATCH`/`DELETE /organization/:id/idp`). |

Both surfaces gate the secret-bearing writes behind step-up re-authentication,
and the self-service surface additionally requires the org to be `sso`-entitled
and only lets an admin touch their own org (or a team they manage). Every
create / update / delete is recorded in the [audit trail](audit-events.md)
(`admin.org-idp.upsert` / `admin.org-idp.delete`).

---

## See also

- [Environment Variables → Authentication](environment-variables.md#authentication) — every `OAUTH_*` variable.
- [Roles & Permissions](permissions.md) — the `org:idp`/`org:kms` capabilities, sessions, and `tokenVersion` invalidation.
- [Billing Add-on Bundles](billing-bundles.md) — the `sso` add-on bundle and feature entitlements.
- [Audit Events](audit-events.md) — SSO/IdP config change actions.
