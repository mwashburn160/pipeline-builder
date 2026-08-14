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
given email is forced through SSO; `GET /auth/sso/:orgId/authorize` returns the
IdP redirect URL; `POST /auth/sso/:orgId/callback` exchanges the code and
validates the `id_token`.

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

### Two config surfaces

The same `OrgIdpConfig` is manageable from two places, which stay in lockstep
(shared service, quota reservation, and audit actions):

| Surface | Who | Where |
|---------|-----|-------|
| **Superadmin / fleet** | Platform operators (Super Admin) | `/admin/org-idp` — register or edit SSO for **any** org on their behalf (the "IdP / SSO" dashboard page). |
| **Org-admin self-service** | An org's own admin | Managed under the org's settings, gated on the `org:settings` capability — the customer's admin configures their own org's SSO without an operator (`GET`/`PUT`/`PATCH`/`DELETE /organization/:id/idp`). |

Both surfaces gate the secret-bearing writes behind step-up re-authentication,
and the self-service surface additionally requires the org to be `sso`-entitled
and only lets an admin touch their own org (or a team they manage). Every
create / update / delete is recorded in the [audit trail](audit-events.md)
(`admin.org-idp.upsert` / `admin.org-idp.delete`).

---

## See also

- [Environment Variables → Authentication](environment-variables.md#authentication) — every `OAUTH_*` variable.
- [Roles & Permissions](permissions.md) — the `org:settings` capability, sessions, and `tokenVersion` invalidation.
- [Billing Add-on Bundles](billing-bundles.md) — the `sso` add-on bundle and feature entitlements.
- [Audit Events](audit-events.md) — SSO/IdP config change actions.
