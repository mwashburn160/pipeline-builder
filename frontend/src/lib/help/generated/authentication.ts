// GENERATED FROM docs/authentication.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 82ce04035bf003bcbfb91cf60cacfa3b78d9e7f0980467c7ab2fb5aec2bd9b22
// SPDX-License-Identifier: Apache-2.0
import { Lock } from 'lucide-react';
import type { HelpTopic } from '../types';

export const authenticationTopic: HelpTopic = {
  "icon": Lock,
  "id": "authentication",
  "title": "Authentication & SSO",
  "description": "Sign-in, MFA and assurance, enterprise SSO (OIDC / SAML), sessions and machine credentials",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline Builder supports four ways to sign in, side by side:"
        },
        {
          "type": "list",
          "items": [
            "Email + password — the always-on baseline (JWT sessions, short-TTL"
          ]
        },
        {
          "type": "text",
          "content": "access tokens + tokenVersion invalidation; see Roles & Permissions)."
        },
        {
          "type": "list",
          "items": [
            "OAuth social login — platform-wide \"Sign in with…\" buttons for Google,"
          ]
        },
        {
          "type": "text",
          "content": "GitHub, Facebook, Microsoft, GitLab, and LinkedIn. Configured once per deployment through environment variables; each provider appears only when its credentials are set."
        },
        {
          "type": "list",
          "items": [
            "Per-org enterprise SSO (OIDC or SAML 2.0) — an organization brings its own"
          ]
        },
        {
          "type": "text",
          "content": "identity provider (Okta, Microsoft Entra ID, AWS Cognito, Auth0, Keycloak, Shibboleth, …). Configured per-org in the app, not by env, and gated on the sso entitlement. Both protocols end at the same verified identity and pass the same checks; see SAML 2.0."
        },
        {
          "type": "list",
          "items": [
            "Passkeys (WebAuthn) — the device itself (fingerprint, face, screen lock,"
          ]
        },
        {
          "type": "text",
          "content": "or a security key). Nothing to configure: a person adds one from Security → Factors and it works from then on. See Passkeys."
        },
        {
          "type": "text",
          "content": "On top of the first of those sits one second factor:"
        },
        {
          "type": "list",
          "items": [
            "Authenticator app (TOTP) — a 6-digit code from a phone, asked for after"
          ]
        },
        {
          "type": "text",
          "content": "the password. Also configured by the person from Security → Factors. See Authenticator app."
        },
        {
          "type": "text",
          "content": "The first two are global: one app registration per provider, shared by every organization on the deployment. The third is per-organization: each org registers its own IdP and can force its users through it. The last two are per-person: a passkey and a TOTP enrolment belong to the account, not to the deployment."
        },
        {
          "type": "text",
          "content": "The CLI does not add a fourth way: pipeline-manager auth login hands the sign-in to a browser through the device authorization grant, so it inherits whichever of the three the account uses — see CLI sign-in by device authorization."
        }
      ]
    },
    {
      "id": "passwords",
      "title": "Passwords",
      "blocks": [
        {
          "type": "text",
          "content": "A password must be at least PASSWORD_MIN_LENGTH characters (default 8, at most 128) with an upper-case letter, a lower-case letter and a digit — checked by the request schema and again by the model before hashing (bcrypt)."
        },
        {
          "type": "text",
          "content": "Breached-password check"
        },
        {
          "type": "text",
          "content": "Every path that sets a password — registration, password change, an admin reset, and the forced change below — also checks it against Have I Been Pwned's \"Pwned Passwords\" corpus with the k-anonymity range API: only the first 5 hex characters of the password's SHA-1 leave the process, the ~800 suffixes that come back (padded, so even the response size says nothing) are compared locally, and a match is refused with PASSWORD_BREACHED."
        },
        {
          "type": "text",
          "content": "PASSWORD_BREACH_CHECK=hibp|off (default hibp; platform already reaches the public internet for OAuth/OIDC). The call has a PASSWORD_BREACH_CHECK_TIMEOUT_MS (2 s) timeout and fails open: a timeout, network error or non-200 lets the password through and is metered as platform_password_breach_checks_total{outcome=\"unavailable\"} (alert on it). Failing closed would make registration, password changes and — worst — an admin resetting a locked-out person's password depend on a third party's uptime, for a check that is defence-in-depth on top of the length/complexity rules and the sign-in throttle. Point PASSWORD_BREACH_CHECK_URL at an internal mirror to keep the check without public egress."
        },
        {
          "type": "text",
          "content": "Org password policy"
        },
        {
          "type": "text",
          "content": "An org admin (org:settings, step-up; lowering it also needs an aal: 2 session) can raise the minimum length for its members — Settings → Organization → Password policy, or PATCH /organization/:id/password-policy with { minLength } (null clears it). It must be ≥ the platform minimum and ≤ 128. A parent org's minimum applies to its teams; the strictest value along the lineage wins. Because one password serves every org a person belongs to, the bar for a person is the strictest effective minimum among all their active memberships."
        },
        {
          "type": "text",
          "content": "Where it is enforced:"
        },
        {
          "type": "list",
          "items": [
            "Setting a password — password change, admin reset (PUT /users/:id), and"
          ]
        },
        {
          "type": "text",
          "content": "admin-created users (PASSWORD_TOO_SHORT_FOR_ORG, 400)."
        },
        {
          "type": "list",
          "items": [
            "Registration through an invitation — the invite page sends"
          ]
        },
        {
          "type": "text",
          "content": "invitationToken with POST /auth/register, and a pending, unexpired invitation addressed to that email makes the inviting org's policy apply."
        },
        {
          "type": "list",
          "items": [
            "Existing passwords — at the next password sign-in. Only bcrypt hashes are"
          ]
        },
        {
          "type": "text",
          "content": "stored, so a raised minimum can't be applied retroactively. The honest check is at POST /auth/login, the one moment the plaintext exists: a password below the person's policy opens no session. The response is { passwordChangeRequired: true, challengeId, expiresAt, minLength } (for an account with an authenticator app, after the code is verified at /auth/mfa/verify), audited as user.password.change_required. POST /auth/password/change-required with { challengeId, newPassword } — a new, compliant, un-breached password different from the old one — saves it, bumps tokenVersion (every other session and token ends) and opens the session the sign-in earned, with the assurance of the leg(s) already completed. The handle is single-use, lives 10 minutes in the shared pending-state store, and a refused new password doesn't burn it. Passkey, social and SSO sign-ins never see a password and are unaffected."
        },
        {
          "type": "text",
          "content": "Sign-in throttling"
        },
        {
          "type": "text",
          "content": "/auth/* sits behind the per-IP auth limiter (AUTH_LIMITER_MAX per AUTH_LIMITER_WINDOWMS, default 20 / 15 min). POST /auth/login additionally has a per-account limiter keyed on a SHA-256 of the normalized (trimmed, lower-cased) identifier that counts only failed attempts (LOGIN_ACCOUNT_LIMITER_MAX / _WINDOWMS, default 10 / 15 min) — so a credential-stuffing run spread across many addresses still stalls on the account, while the owner's successful sign-ins never consume the budget. Both use the shared Redis rate-limit store (limits hold across replicas; a store outage lets requests through). The trade-off: anyone who knows an identifier can delay its password sign-in for one window; passkey, social and SSO sign-in are unaffected. TOTP codes have their own per-account lockout."
        }
      ]
    },
    {
      "id": "oauth-social-login-platform-wide",
      "title": "OAuth social login (platform-wide)",
      "blocks": [
        {
          "type": "text",
          "content": "Social login is enabled per provider by setting that provider's client credentials as environment variables on the platform service. A provider is enabled if and only if its OAUTH_<P>_CLIENT_ID is set — the behavior is fail-soft: an unconfigured provider is simply hidden, never an error. The login page fetches the enabled set (GET /api/auth/oauth/providers) and renders its buttons data-driven, so a \"Sign in with GitLab\" button appears the moment GitLab credentials are present and disappears when they're removed."
        },
        {
          "type": "text",
          "content": "Credentials are global / platform-wide — one app registration per provider covers the whole deployment. There is no per-org social-login registration."
        },
        {
          "type": "text",
          "content": "The buttons are hidden for anyone whose email domain is federated: social login is one of the bypasses the backend refuses for a covered account, so the card offers that org's SSO instead."
        },
        {
          "type": "text",
          "content": "Supported providers"
        },
        {
          "type": "table",
          "headers": [
            "Provider",
            "Env vars",
            "Register an app at"
          ],
          "rows": [
            [
              "Google",
              "OAUTH_GOOGLE_CLIENT_ID, OAUTH_GOOGLE_CLIENT_SECRET",
              "Google Cloud Console → OAuth 2.0 Client ID"
            ],
            [
              "GitHub",
              "OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET",
              "GitHub → Settings → Developer settings → OAuth Apps"
            ],
            [
              "Facebook",
              "OAUTH_FACEBOOK_CLIENT_ID, OAUTH_FACEBOOK_CLIENT_SECRET",
              "Meta for Developers → Facebook Login"
            ],
            [
              "Microsoft",
              "OAUTH_MICROSOFT_CLIENT_ID, OAUTH_MICROSOFT_CLIENT_SECRET, OAUTH_MICROSOFT_TENANT",
              "Microsoft Entra admin center → App registrations"
            ],
            [
              "GitLab",
              "OAUTH_GITLAB_CLIENT_ID, OAUTH_GITLAB_CLIENT_SECRET, OAUTH_GITLAB_BASE_URL",
              "GitLab → User Settings → Applications (or your self-hosted instance)"
            ],
            [
              "LinkedIn",
              "OAUTH_LINKEDIN_CLIENT_ID, OAUTH_LINKEDIN_CLIENT_SECRET",
              "LinkedIn Developers → \"Sign in with LinkedIn using OpenID Connect\""
            ]
          ]
        },
        {
          "type": "text",
          "content": "Shared across all providers:"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "OAUTH_CALLBACK_BASE_URL",
              "${PLATFORM_FRONTEND_URL}",
              "Origin the provider redirects back to. Each handler appends /auth/callback/<provider> (e.g. /auth/callback/microsoft). Register this exact callback URL in the provider's console."
            ],
            [
              "OAUTH_STATE_TTL_MS",
              "600000",
              "CSRF state token TTL (10 min)."
            ],
            [
              "OAUTH_CLEANUP_INTERVAL_MS",
              "60000",
              "Stale-state cleanup interval."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Provider-specific notes:"
        },
        {
          "type": "list",
          "items": [
            "Microsoft (Entra / Azure AD v2, OIDC) — OAUTH_MICROSOFT_TENANT scopes the"
          ]
        },
        {
          "type": "text",
          "content": "authority and defaults to common (any organizational or personal account); set it to a specific tenant id or domain to restrict to one directory. The tenant is interpolated into the authorize/token URLs; userinfo is the tenant-agnostic Microsoft Graph endpoint."
        },
        {
          "type": "list",
          "items": [
            "GitLab (OIDC) — OAUTH_GITLAB_BASE_URL defaults to https://gitlab.com;"
          ]
        },
        {
          "type": "text",
          "content": "point it at a self-hosted GitLab instance to authenticate against that. The email must be verified (email_verified === true)."
        },
        {
          "type": "list",
          "items": [
            "LinkedIn — uses \"Sign in with LinkedIn using OpenID Connect\"; email is"
          ]
        },
        {
          "type": "text",
          "content": "taken from the OIDC email claim."
        },
        {
          "type": "text",
          "content": "Registering the callback URL"
        },
        {
          "type": "text",
          "content": "Whatever OAUTH_CALLBACK_BASE_URL resolves to, the redirect URI you register in each provider's developer console is:"
        },
        {
          "type": "code",
          "content": "<OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>"
        },
        {
          "type": "text",
          "content": "for example https://ci.acme.com/auth/callback/google. A mismatch here is the most common cause of a failed social login."
        },
        {
          "type": "text",
          "content": "Per-provider setup walkthroughs"
        },
        {
          "type": "text",
          "content": "Each walkthrough registers one platform-wide app in the provider's console, sets the redirect URI to <OAUTH_CALLBACK_BASE_URL>/auth/callback/<provider>, and copies the resulting client ID/secret into the env vars below. The scopes listed are the ones the platform requests automatically — you generally don't declare them in the console (Google, Microsoft, GitLab, and LinkedIn surface a consent screen; GitHub and Facebook request scopes at authorize time). Replace <base> with whatever OAUTH_CALLBACK_BASE_URL resolves to."
        },
        {
          "type": "text",
          "content": "Google"
        },
        {
          "type": "list",
          "items": [
            "Google Cloud Console → pick/create a project.",
            "OAuth consent screen (first time only): User type External, set app name + support email, add scopes openid, email, profile. While the screen is in Testing only listed test users can sign in — Publish it to allow anyone.",
            "Credentials → Create Credentials → OAuth client ID → Web application.",
            "Authorized redirect URIs → add <base>/auth/callback/google.",
            "Copy the Client ID/secret → OAUTH_GOOGLE_CLIENT_ID, OAUTH_GOOGLE_CLIENT_SECRET."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: openid email profile. The account's email_verified must be true."
        },
        {
          "type": "code",
          "content": "OAUTH_GOOGLE_CLIENT_ID=your-client-id\nOAUTH_GOOGLE_CLIENT_SECRET=your-client-secret",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "GitHub"
        },
        {
          "type": "list",
          "items": [
            "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.",
            "Homepage URL = your frontend URL; Authorization callback URL = <base>/auth/callback/github.",
            "Generate a new client secret, then copy both → OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: read:user user:email (OAuth Apps don't pre-declare scopes). The platform reads the primary verified email via /user/emails, so a user with no verified email can't sign in."
        },
        {
          "type": "code",
          "content": "OAUTH_GITHUB_CLIENT_ID=your-client-id\nOAUTH_GITHUB_CLIENT_SECRET=your-client-secret",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Facebook"
        },
        {
          "type": "list",
          "items": [
            "Meta for Developers → Create App (use case: Authenticate and request data from users with Facebook Login) → add the Facebook Login product (Web).",
            "Facebook Login → Settings → Valid OAuth Redirect URIs → add <base>/auth/callback/facebook.",
            "App settings → Basic: App ID → OAUTH_FACEBOOK_CLIENT_ID, App Secret → OAUTH_FACEBOOK_CLIENT_SECRET.",
            "Switch the app from Development to Live so non-admin users can log in. The email permission is granted by default for login, but going live for a broad audience may require Meta App Review / Advanced Access for email."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: email,public_profile. Facebook is OAuth2 (not OIDC); if the user declines email the login fails because no account email is returned."
        },
        {
          "type": "code",
          "content": "OAUTH_FACEBOOK_CLIENT_ID=your-app-id\nOAUTH_FACEBOOK_CLIENT_SECRET=your-app-secret",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Microsoft (Entra / Azure AD)"
        },
        {
          "type": "list",
          "items": [
            "Microsoft Entra admin center → App registrations → New registration.",
            "Supported account types decides who can sign in and maps to OAUTH_MICROSOFT_TENANT: any org + personal → common; single directory → that tenant's ID/domain.",
            "Redirect URI → platform Web → <base>/auth/callback/microsoft.",
            "Certificates & secrets → New client secret → copy the Value (not the ID) → OAUTH_MICROSOFT_CLIENT_SECRET. Overview → Application (client) ID → OAUTH_MICROSOFT_CLIENT_ID. Set OAUTH_MICROSOFT_TENANT (common unless you scoped to one directory)."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: openid email profile."
        },
        {
          "type": "code",
          "content": "OAUTH_MICROSOFT_CLIENT_ID=your-application-client-id\nOAUTH_MICROSOFT_CLIENT_SECRET=your-client-secret-value\nOAUTH_MICROSOFT_TENANT=common",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "GitLab"
        },
        {
          "type": "list",
          "items": [
            "GitLab → User Settings → Applications (or <your-instance>/-/profile/applications) → Add new application.",
            "Redirect URI → <base>/auth/callback/gitlab; check scopes openid, email, profile; keep Confidential enabled.",
            "Copy Application ID → OAUTH_GITLAB_CLIENT_ID, Secret → OAUTH_GITLAB_CLIENT_SECRET. For a self-hosted instance also set OAUTH_GITLAB_BASE_URL to its origin."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: openid email profile. The GitLab email must be verified."
        },
        {
          "type": "code",
          "content": "OAUTH_GITLAB_CLIENT_ID=your-application-id\nOAUTH_GITLAB_CLIENT_SECRET=your-secret\nOAUTH_GITLAB_BASE_URL=https://gitlab.example.com",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "LinkedIn"
        },
        {
          "type": "list",
          "items": [
            "LinkedIn Developers → Create app (requires an associated LinkedIn Company Page).",
            "Products tab → request \"Sign in with LinkedIn using OpenID Connect\".",
            "Auth tab → Authorized redirect URLs for your app → add <base>/auth/callback/linkedin. Copy the Client ID/secret → OAUTH_LINKEDIN_CLIENT_ID, OAUTH_LINKEDIN_CLIENT_SECRET."
          ]
        },
        {
          "type": "text",
          "content": "Requested scopes: openid email profile."
        },
        {
          "type": "code",
          "content": "OAUTH_LINKEDIN_CLIENT_ID=your-client-id\nOAUTH_LINKEDIN_CLIENT_SECRET=your-client-secret",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Apply and verify"
        },
        {
          "type": "list",
          "items": [
            "Set the provider's OAUTH_<P>_CLIENT_ID / _CLIENT_SECRET (and any provider-specific var) on the platform service, plus OAUTH_CALLBACK_BASE_URL if it isn't already your public frontend origin.",
            "Restart/redeploy the platform service.",
            "Confirm the provider is live: curl <PLATFORM_BASE_URL>/api/auth/oauth/providers lists it, and a matching \"Sign in with …\" button appears on the login page.",
            "Click it end-to-end. A redirect-URI mismatch is by far the most common failure — the URI in the console must equal <base>/auth/callback/<provider> exactly (scheme, host, and path)."
          ]
        },
        {
          "type": "text",
          "content": "What happens on first sign-in (account + org creation)"
        },
        {
          "type": "text",
          "content": "Social login and social sign-up are the same flow — there is no separate OAuth registration endpoint. The callback verifies the provider identity, then resolves it in three cases (authService.findOrCreateOAuthUser):"
        },
        {
          "type": "list",
          "items": [
            "Returning identity — a user already linked to this provider's account id → straight login, nothing created.",
            "Email already registered — a user with the same (provider-verified) email exists → the provider is linked to that existing account and they're logged in. This is how signing in with, say, Facebook later attaches to the account first created with Google under the same email — no second organization is created. Hardening: the silent link happens only when the pre-existing account's own email is verified (isEmailVerified). Linking into an unverified account is refused with a 409 (ACCOUNT_EMAIL_UNVERIFIED) — this closes the vector where someone plants an unverified password account on a victim's address and gets the victim signed into it on their first social login. The user verifies (or resets the password on) that account first, then links.",
            "Brand-new identity → auto-provision. A new User is created (marked email-verified, since the provider verified it) and flagged needsOnboarding, and in a single transaction the platform also creates:",
            "a personal organization, initially named after the derived username (from the provider's display name, else the email local-part — lowercased, stripped to [a-z0-9_-], length-capped, and made unique);",
            "an owner membership for the new user;",
            "the default Admin/Member roles — identical to what email registration seeds."
          ]
        },
        {
          "type": "text",
          "content": "First-run onboarding. Because a social signup collected no org name or plan, a brand-new user is flagged needsOnboarding and the app's auth guard routes them to a one-time \"Name your organization\" screen (/dashboard/onboarding) before the dashboard. There they rename the auto-created org and — when billing is enabled — pick a plan; POST /auth/onboarding/complete renames the org (reusing the identity-rename path), provisions the plan (fire-and-forget, mirroring register), and clears the flag. \"Skip for now\" keeps the derived name and clears the flag. Email/password registrants and SSO-provisioned users are not flagged (they already supplied an org name or belong to an enforced org)."
        },
        {
          "type": "text",
          "content": "A few consequences worth knowing:"
        },
        {
          "type": "list",
          "items": [
            "Tier. The new org takes the default quota tier and is not provisioned to"
          ]
        },
        {
          "type": "text",
          "content": "a paid tier until billing does so (no free paid-tier grant). When billing is off, the onboarding plan step is hidden and any planId is inert."
        },
        {
          "type": "list",
          "items": [
            "Facebook needs email. Facebook only returns an email if the user grants the"
          ]
        },
        {
          "type": "text",
          "content": "email scope; if they decline, sign-in fails with OAUTH_NO_EMAIL and no account or org is created."
        },
        {
          "type": "list",
          "items": [
            "SSO enforcement still applies. If the email's domain is covered by an"
          ]
        },
        {
          "type": "text",
          "content": "enabled, sso-entitled org IdP, the social grant is rejected with SSO_REQUIRED (see enforcement) rather than creating a personal org — the user is routed through their org's IdP instead."
        },
        {
          "type": "text",
          "content": "PKCE on every authorization-code flow"
        },
        {
          "type": "text",
          "content": "Every authorization-code flow the platform starts — social sign-in, per-org SSO, and the step-up provider re-auth that shares their helpers — is protected with PKCE (RFC 7636), always with S256."
        },
        {
          "type": "list",
          "items": [
            "The initiate leg mints a fresh 43-character code_verifier and sends only its"
          ]
        },
        {
          "type": "text",
          "content": "SHA-256 code_challenge in the redirect. The verifier never leaves the server and never reaches the browser: it is stored with the single-use pending state in the shared Redis, so it is cross-replica, dies with that state, and is usable exactly once."
        },
        {
          "type": "list",
          "items": [
            "The token exchange presents the verifier. A leaked or intercepted"
          ]
        },
        {
          "type": "text",
          "content": "authorization code is therefore worthless to anyone else — the provider re-derives the challenge and refuses a code redeemed with the wrong verifier."
        },
        {
          "type": "list",
          "items": [
            "No downgrade. plain is never offered or accepted. For per-org SSO the"
          ]
        },
        {
          "type": "text",
          "content": "issuer's code_challenge_methods_supported is honoured: S256 when it is advertised, S256 anyway when the document omits the field (advertising is optional and an unknown authorization parameter is ignored), and no PKCE at all for an issuer that advertises only plain. Once a challenge has gone out, an exchange without its verifier is refused rather than retried unprotected."
        },
        {
          "type": "list",
          "items": [
            "Per-provider support is taken from each provider's current documentation:"
          ]
        },
        {
          "type": "text",
          "content": "Google, Microsoft Entra, GitLab, GitHub (OAuth Apps, since July 2025) and generic OIDC issuers get PKCE. LinkedIn does not — its PKCE flow must be enabled per app by LinkedIn and uses a different authorization endpoint, and it does not ignore the extra parameters. Facebook does not — Meta documents code_challenge only for its separate OIDC code flow, not the Graph-API flow used here. Those two keep state as their CSRF protection; nothing else about them changes."
        },
        {
          "type": "note",
          "content": "Cutover: there is no compatibility path. Any sign-in, SSO login or step-up re-auth that is mid-flight when the new build rolls out fails with an invalid-state error; the user retries and gets a PKCE-protected flow. Nothing needs to be configured, and no identity-provider settings change."
        },
        {
          "type": "text",
          "content": "Providers reachable via generic OIDC"
        },
        {
          "type": "text",
          "content": "Apple, X (Twitter), Amazon, Discord, and Slack are not named social-login buttons today. Where they are OIDC-compliant they can be wired up as a per-org enterprise SSO provider through generic OIDC (below). Apple is not a native button: it needs an ES256 signed-JWT client secret and a form_post callback, so it does not fit the standard OAuth handler."
        }
      ]
    },
    {
      "id": "per-org-enterprise-sso",
      "title": "Per-org enterprise SSO",
      "blocks": [
        {
          "type": "text",
          "content": "An organization can register its own identity provider so its users sign in through corporate SSO instead of a password. This is configured per organization inside the app — never through environment variables — and is stored as an OrgIdpConfig (one config per org)."
        },
        {
          "type": "text",
          "content": "One config, one protocol: protocol selects OIDC (this section) or SAML 2.0. Switching the selector keeps the other protocol's settings, so moving between them never means re-entering a connection, and a write that would leave the selected protocol unable to sign anyone in is refused rather than saved. Everything after the assertion — the org's DNS-verified authority over the email domain, issuer-bound linking, the platform-admin refusal, the sso entitlement, JIT membership and group → role mapping — is identical on both."
        },
        {
          "type": "text",
          "content": "How it works"
        },
        {
          "type": "list",
          "items": [
            "Per-org credentials. Each org supplies its own OIDC clientId /"
          ]
        },
        {
          "type": "text",
          "content": "clientSecret. The client secret is encrypted at rest (per-org HKDF-derived key + AES-256-GCM) and is never returned in plaintext by the config API."
        },
        {
          "type": "list",
          "items": [
            "Discovery + JWKS-validated id_token. The login flow reads the IdP's"
          ]
        },
        {
          "type": "text",
          "content": "OIDC discovery document (/.well-known/openid-configuration), exchanges the authorization code, and validates the returned id_token signature against the IdP's published JWKS before trusting any identity claim."
        },
        {
          "type": "list",
          "items": [
            "Verified domains decide who SSO serves. An enabled connection serves the"
          ]
        },
        {
          "type": "text",
          "content": "email domains the org (or its account root) has verified through DNS (Settings → Organization → domains). allowedEmailDomains optionally narrows that to a subset — it is a picker over verified domains, and the write path refuses a domain the org has not verified (IDP_DOMAIN_NOT_VERIFIED), because an unverified entry proves nothing. Only IdP users whose email is in a served domain may sign in to that org (so an over-broad corporate IdP can't let evil-contractor.com in through your acme.com config)."
        },
        {
          "type": "list",
          "items": [
            "Offered vs. required. Enabling SSO offers it to people in the served"
          ]
        },
        {
          "type": "text",
          "content": "domains. Refusing every other sign-in method for them is a separate, explicit org policy — SSO required — which can only be switched on after a test connection has succeeded, and which always exempts the org's owners (the break-glass path)."
        },
        {
          "type": "list",
          "items": [
            "The org must own the email domain — every provider except Google Workspace."
          ]
        },
        {
          "type": "text",
          "content": "An org's own IdP can sign any address as verified, so an SSO sign-in is refused (OIDC_EMAIL_DOMAIN_NOT_VERIFIED) unless the email's domain is one the org (or its account root) has verified through DNS. Google (provider: google) is the single exception, and the reason is who does the verifying: an accounts.google.com identity can only be minted for a domain Google itself has confirmed the customer controls, so the org's DNS proof would restate something Google has already established. Every other IdP — Okta, Entra, Cognito, Auth0, Keycloak, any generic OIDC provider, and all SAML connections — is run by the customer's own admin, who could sign someone@a-competitor.com just as easily as their own staff, so the DNS proof is what makes the claim trustworthy. The carve-out is narrow: it exempts only the identity-trust check at callback. Domain-based discovery (\"Continue with single sign-on\" from the login page, and the SSO-required lookup) still requires a verified domain for every provider, Google included, and SSO required is refused outright without one (IDP_SSO_REQUIRED_NO_DOMAIN). So a Google connection works with no verified domain, but only for sign-ins that start at the org's own SSO URL — verify a domain regardless. An SSO identity is linked by its subject and issuer, so one IdP can't claim another's users."
        },
        {
          "type": "list",
          "items": [
            "Platform administrators never sign in through an org's SSO, and SSO never"
          ]
        },
        {
          "type": "text",
          "content": "links onto a platform administrator's account."
        },
        {
          "type": "list",
          "items": [
            "sso entitlement. SSO is a tier feature, included from Team up"
          ]
        },
        {
          "type": "text",
          "content": "(Team / Enterprise / the billing-off unlimited tier). It is not sold as an add-on bundle — a lower tier that needs SSO upgrades, because SSO also needs a DNS-verified domain and domain registration is itself a Team+ check (see Billing Add-on Bundles). It enforces only when the org's config is enabled and the org is sso-entitled. Entitlements pool at the account root, so a team reads its root's entitlement. A disabled or unentitled config is a no-op: password login keeps working and the SSO routes refuse — a half-configured or downgraded org never locks its users out."
        },
        {
          "type": "text",
          "content": "Signing in with SSO"
        },
        {
          "type": "text",
          "content": "The sign-in card offers SSO on its own, from the address the person types — they never have to know their org's id, and an admin never has to hand out a link."
        },
        {
          "type": "list",
          "items": [
            "Discovery. Once the identifier looks like an email, the page asks"
          ]
        },
        {
          "type": "text",
          "content": "POST /auth/sso/discover (debounced, and once per domain — a username is never asked about at all, and the request shares the pre-auth rate limit with login). It returns only { sso: boolean, required: boolean } — does an enabled, entitled IdP serve this domain, and does its org require SSO — and deliberately does not leak the internal orgId or provider: it is unauthenticated, so returning those would make it a tenant-enumeration oracle. The answer is about the domain, so an address with no account behind it looks exactly like one that has (and an owner's address looks like anyone else's — the break-glass exemption is never revealed here)."
        },
        {
          "type": "list",
          "items": [
            "SSO required: no password path. On { required: true } the password"
          ]
        },
        {
          "type": "text",
          "content": "field, the passkey button and the social buttons all go away and a single \"Continue with single sign-on\" action takes their place — those three are refused server-side for a covered, non-owner account. A small \"Organization owner? Sign in with your password or passkey\" link gives the password path back; the server decides whether the person really is an owner. SSO offered: on { sso: true, required: false } the password form stays and a secondary \"Continue with single sign-on\" button is added."
        },
        {
          "type": "list",
          "items": [
            "Starting the flow. The action calls POST /auth/sso/start with the"
          ]
        },
        {
          "type": "text",
          "content": "address; the serving org is resolved server-side and the same { url, state } comes back that the by-org route returns, so the login page is never told which tenant owns the domain (404 SSO_NOT_AVAILABLE when no IdP serves it). The browser then goes to the IdP and returns on whichever leg the protocol uses — /auth/sso/:orgId/callback for OIDC, the ACS → /auth/sso/:orgId/saml for SAML."
        },
        {
          "type": "list",
          "items": [
            "A password typed anyway. Discovery is a hint and can miss — a username"
          ]
        },
        {
          "type": "text",
          "content": "instead of an address, a blocked or rate-limited request. The password login is refused with 403 SSO_REQUIRED, which does name the org and provider, and the card swaps to the same SSO action (labelled \"Continue with Okta\", say) initiated through GET /auth/sso/:orgId/authorize. A discovery that fails for any reason is treated as \"not federated\": the hint never blocks a sign-in, because this refusal still closes the path."
        },
        {
          "type": "text",
          "content": "Bootstrap admins keep their password field. SSO refuses platform superadmins, so discover answers false for an address in BOOTSTRAP_SUPERADMIN_EMAILS — the same carve-out password login makes. Without it, a verified SSO-enforced domain matching that address would close both ways in."
        },
        {
          "type": "text",
          "content": "GET /auth/sso/:orgId/authorize returns the IdP redirect URL for whichever protocol the org uses — the client just redirects to it; POST /auth/sso/:orgId/callback exchanges the code and validates the id_token (OIDC), while a SAML assertion arrives at its own ACS endpoint."
        },
        {
          "type": "text",
          "content": "Social login also honors SSO required. A (non-owner) user in a domain whose org requires SSO cannot bypass the IdP by using \"Sign in with Google/GitHub/…\" or a passkey — the OAuth callback and the passkey and TOTP sign-in legs run the same check as password login and reject with SSO_REQUIRED."
        },
        {
          "type": "text",
          "content": "SSO required"
        },
        {
          "type": "text",
          "content": "SSO required (ssoRequired on the IdP config) is the org policy that turns single sign-on from offered into mandatory:"
        },
        {
          "type": "list",
          "items": [
            "Who it governs. People whose email is in a domain the connection serves —"
          ]
        },
        {
          "type": "text",
          "content": "the org's DNS-verified domains, narrowed by allowedEmailDomains when set."
        },
        {
          "type": "list",
          "items": [
            "What it refuses. Password sign-in (by email and by username — checked"
          ]
        },
        {
          "type": "text",
          "content": "again once the account is known), passkey sign-in, TOTP sign-in, and social (OAuth) sign-in all answer 403 SSO_REQUIRED naming the org, so the sign-in page can start the SSO flow directly. The same accounts cannot enrol an authenticator app (their IdP owns their factors)."
        },
        {
          "type": "list",
          "items": [
            "Break-glass: owners are exempt. An account that is an owner of the org"
          ]
        },
        {
          "type": "text",
          "content": "(or of its account root, for a team's IdP) is never refused: owners always keep their own password, passkey and social sign-in. That is what keeps an expired IdP certificate, a deleted IdP application or a mis-typed setting from locking the organization out of fixing it. (Platform bootstrap administrators, whom SSO refuses outright, are likewise never routed to it.) Keep at least one owner with a strong, non-SSO factor. The pre-credential check on an email identifier means an owner's address is distinguishable from a member's by the password endpoint's answer (401 vs 403) — owner addresses are usually known anyway, and the endpoint is rate-limited like every other sign-in attempt."
        },
        {
          "type": "list",
          "items": [
            "Lock-out prevention. It can only be switched on when the connection is"
          ]
        },
        {
          "type": "text",
          "content": "enabled, the org has at least one verified domain, and a test connection has succeeded against the settings currently saved, on the current protocol (409 IDP_SSO_REQUIRED_UNTESTED / IDP_SSO_REQUIRED_NO_DOMAIN otherwise). Any change to the connection (protocol, provider, client id/secret, discovery URL, entity ID, SSO URL, certificates, signing / encryption switches) clears the last test result, so a success always speaks for what is saved. Switching it off is always allowed."
        },
        {
          "type": "list",
          "items": [
            "Changing it is a PATCH /organization/:id/idp with { ssoRequired }, so"
          ]
        },
        {
          "type": "text",
          "content": "it carries the IdP writes' MFA-grade assurance and strong step-up. Every change is audited as org.sso.required.update (details.from / to)."
        },
        {
          "type": "text",
          "content": "The settings page shows the state (a \"SSO required\" / \"SSO optional\" badge) and why the switch is locked when it is."
        },
        {
          "type": "text",
          "content": "Setting up SSO (the wizard)"
        },
        {
          "type": "text",
          "content": "Settings → Single Sign-On opens a six-step wizard when the org has no connection yet:"
        },
        {
          "type": "list",
          "items": [
            "Protocol & provider — OIDC or SAML 2.0, plus a provider preset (Okta,"
          ]
        },
        {
          "type": "text",
          "content": "Microsoft Entra ID, Google / Google Workspace, AWS Cognito, or generic). A preset pre-selects what it knows (the OIDC provider type, the SAML attribute names) and names the IdP console screens to use."
        },
        {
          "type": "list",
          "items": [
            "Service-provider values — everything to register at the IdP, read"
          ]
        },
        {
          "type": "text",
          "content": "from the server (GET /organization/:id/idp/sp-info, computed from OAUTH_CALLBACK_BASE_URL — never guessed from the browser's address), each with a copy button: the OIDC redirect URI; or the SAML entity ID, ACS URL, SLO URL, metadata URL and SP certificates."
        },
        {
          "type": "list",
          "items": [
            "Identity-provider details — the OIDC client, or the SAML connection, which"
          ]
        },
        {
          "type": "text",
          "content": "can be imported from the IdP's metadata. Saving creates the connection disabled."
        },
        {
          "type": "list",
          "items": [
            "Domains — which verified domains it serves (with a link to verify one when"
          ]
        },
        {
          "type": "text",
          "content": "there are none). Unless the provider is Google Workspace, sign-ins are refused until at least one domain is verified — see the domain rule."
        },
        {
          "type": "list",
          "items": [
            "Test connection — a dry run.",
            "Enable — switch the connection on, and optionally"
          ]
        },
        {
          "type": "text",
          "content": "require SSO."
        },
        {
          "type": "text",
          "content": "Once a connection exists the page shows a status summary instead — protocol, IdP, enabled / required badges, the last test, domains, and for SAML the SLO and signing / encryption state — with Edit (reopens the wizard at the details step), Change domains, Resume setup (the first unfinished step), Test connection, the enable and SSO-required switches, then group → role mappings, SCIM and Disconnect. Every write keeps the IdP routes' MFA-grade assurance and strong step-up."
        },
        {
          "type": "text",
          "content": "Test connection (dry run)"
        },
        {
          "type": "text",
          "content": "Test connection (POST /organization/:id/idp/test → { url, state }) makes the real round trip to the IdP in a popup — the same authorize request or AuthnRequest, and on the way back the same signature, issuer, audience, nonce / InResponseTo, replay, encryption, domain-authority, platform-admin and seat checks a sign-in runs — and returns a report instead of a session:"
        },
        {
          "type": "list",
          "items": [
            "success or failure, with a stable reason (invalid_assertion,"
          ]
        },
        {
          "type": "text",
          "content": "domain_not_verified, no_email, invalid_id_token, token_exchange_failed, encryption_required, platform_admin, seat_limit, idp_error, …) and what to check;"
        },
        {
          "type": "list",
          "items": [
            "the asserted email, name, subject and groups, and **which group → role"
          ]
        },
        {
          "type": "text",
          "content": "mappings would apply**."
        },
        {
          "type": "text",
          "content": "It works before the connection is enabled — that is the point — and it creates nothing: no session, no account, no membership, no role. That is guaranteed four ways: the test state / RelayState carries a signed ssotest. marker and lives in its own single-use store bound to the admin who started it (the real callback and ACS never consult it, so they refuse it); a test AuthnRequest's id is kept in a separate request-id cache, so a test assertion can't answer a sign-in and vice versa (and its assertion id is burned by the test's replay guard); the test's OIDC nonce and PKCE verifier exist only in the test store; and the test path never calls the account, membership or token code at all. The popup lands on the ordinary sign-in pages, which spot the marker and hand it back to the settings page; that page collects the report (POST /organization/:id/idp/test/complete) over the admin's own session."
        },
        {
          "type": "text",
          "content": "The result is recorded as the connection's last test (only if the settings did not change while it ran) — which is what SSO required checks — and audited as sso.test (stage: 'start' | 'complete', with ok, reason, the asserted email and whether it was recorded)."
        },
        {
          "type": "text",
          "content": "SSO uses the same PKCE protection as social sign-in — see PKCE on every authorization-code flow for how the issuer's advertised methods are honoured."
        },
        {
          "type": "note",
          "content": "Multi-replica: the OAuth/SSO CSRF state, the OIDC nonce, the PKCE code_verifier, and SAML's RelayState, request ids, spent assertion ids and sign-in handoff are held in the shared Redis, so the authorize and the callback (or the assertion POST) can land on different replicas. Without Redis they fall back to per-pod memory (single-replica only) — and a SAML replay guard is then only as wide as one pod, so a multi-replica SAML deployment needs Redis."
        },
        {
          "type": "text",
          "content": "Supported IdP providers"
        },
        {
          "type": "text",
          "content": "For protocol: 'saml' there is no provider list: any SAML 2.0 identity provider works, because the connection is described by its entity ID, SSO URL and signing certificate rather than by a name. For protocol: 'oidc' the providers are the OIDC-capable set (deliberately narrower than the social-login list — a standards-OIDC id_token flow is required):"
        },
        {
          "type": "list",
          "items": [
            "generic-oidc — any OIDC issuer with a discovery URL. Covers **Okta,"
          ]
        },
        {
          "type": "text",
          "content": "Microsoft Entra ID, Auth0, Ping, OneLogin, Keycloak, and AWS IAM Identity Center**, plus any other compliant issuer (this is also the path for Apple / X / Amazon / Discord / Slack where they are OIDC-compliant)."
        },
        {
          "type": "list",
          "items": [
            "cognito — AWS Cognito as a named provider. The admin supplies the"
          ]
        },
        {
          "type": "text",
          "content": "region + userPoolId and the discovery URL is derived (https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration) — no hand-entered URL. (A Cognito user-pool id is not an AWS account id and is safe to store.)"
        },
        {
          "type": "list",
          "items": [
            "google — Google Workspace as a named provider. The discovery URL is"
          ]
        },
        {
          "type": "text",
          "content": "well-known, so there is none to enter; you supply the client id/secret only."
        },
        {
          "type": "list",
          "items": [
            "github — GitHub as a named provider, for orgs already standardised on"
          ]
        },
        {
          "type": "text",
          "content": "GitHub identities."
        },
        {
          "type": "text",
          "content": "Just-in-time membership and group → role mapping"
        },
        {
          "type": "text",
          "content": "An SSO sign-in adds the person to the organization and assigns the roles their IdP groups map to. Nobody has to be invited separately, and role changes made in the directory reach Pipeline Builder at the member's next sign-in."
        },
        {
          "type": "list",
          "items": [
            "Membership. The first successful SSO sign-in creates the membership as a"
          ]
        },
        {
          "type": "text",
          "content": "plain member of the SSO org. A mapping can raise the effective role by granting a role that confers admin, but it can never make anyone an owner and never provisions a platform administrator (who cannot sign in through an org's SSO at all). Nothing outside the SSO org is touched."
        },
        {
          "type": "list",
          "items": [
            "Groups claim. The claim carrying group membership is configured per IdP"
          ]
        },
        {
          "type": "text",
          "content": "(groupsClaim): groups for Okta and Keycloak, cognito:groups for Cognito, roles for Entra. Leave it empty for the groups default. Matching ignores case. Not available for Google — Google's OIDC tokens carry no group claim (group data lives behind the Workspace Admin SDK), so setting the claim or creating a mapping on a google config is refused with an explanation. Google SSO users are still added to the org as members."
        },
        {
          "type": "list",
          "items": [
            "Mappings. Each rule maps one group to a set of the org's roles; a member of"
          ]
        },
        {
          "type": "text",
          "content": "several mapped groups gets the union. Editing them requires roles:manage — a mapping is a role grant — plus the org's own sso entitlement, and each role must be within the editor's own permission ceiling, exactly as a direct role assignment is. A mapping can never name a role granting platform-admin."
        },
        {
          "type": "list",
          "items": [
            "Manual roles are separate. Roles an administrator assigns by hand are"
          ]
        },
        {
          "type": "text",
          "content": "tracked separately (source: manual) and are never removed by a sync — only roles a mapping granted are withdrawn when the group stops matching. An admin who re-grants a mapped role by hand takes ownership of it permanently."
        },
        {
          "type": "list",
          "items": [
            "Seats. JIT goes through the same pooled seat check as invitations. If the"
          ]
        },
        {
          "type": "text",
          "content": "account is at its seat limit, the sign-in is refused with a seat-limit message (rather than opening a session with no membership); the refusal is audited (sso.jit.refused) and counted (platform_sso_jit_refused_total{reason=\"seat_limit\"}). Free a seat or raise the limit, and the next sign-in succeeds."
        },
        {
          "type": "list",
          "items": [
            "Deactivated members stay deactivated. If an admin has deactivated someone's"
          ]
        },
        {
          "type": "text",
          "content": "membership, a later SSO sign-in does not silently reactivate it."
        },
        {
          "type": "list",
          "items": [
            "Entitlement. JIT and mapping live inside the existing sso entitlement —"
          ]
        },
        {
          "type": "text",
          "content": "there is no separate add-on. After a downgrade JIT turns off along with SSO; memberships and roles already granted stay exactly as they are."
        },
        {
          "type": "text",
          "content": "Mappings are managed on Settings → Single Sign-On, or through GET/POST /organization/:id/idp/group-mappings and PUT/DELETE /organization/:id/idp/group-mappings/:mappingId. Every provision and role change is audited (sso.jit.provision, sso.jit.role.change) and counted (platform_sso_jit_provisioned_total)."
        },
        {
          "type": "note",
          "content": "Operator note (fresh behaviour, no migration): orgs that already have SSO configured start provisioning memberships on the next sign-in. Until a mapping exists, members get the built-in Member role only — existing role assignments are untouched because they are all manual."
        },
        {
          "type": "text",
          "content": "SCIM 2.0 provisioning"
        },
        {
          "type": "text",
          "content": "Just-in-time provisioning only reaches people who sign in. SCIM closes the other half: the directory pushes creates, updates, deactivations and group membership as they happen, so someone removed in the IdP loses access here without waiting for anyone to notice."
        },
        {
          "type": "text",
          "content": "Base URL: https://<your-host>/api/scim/v2 — the same for every organization. There is no org id in any path: the org is the one the presenting key belongs to, so a mis-copied URL can only ever fail, never cross tenants."
        },
        {
          "type": "text",
          "content": "Credential: a service-account key carrying the scim scope, issued on Settings → Single Sign-On → SCIM provisioning (which creates a dedicated scim-provisioning service account on first use). Present it as Authorization: Bearer pb_sa_…. A person's token is refused outright — SCIM is machine-to-machine by construction — and a scoped key carries no permissions at all, so it can do exactly this and nothing else. Issuing one requires service_accounts:manage and a step-up confirmation, like every key mint."
        },
        {
          "type": "text",
          "content": "The IdP presents the opaque key itself (no exchange step — platform owns the key collection and resolves it in place), so each request consumes one unit of the owning account's token-exchange budget. The scim-provisioning account is created with an unlimited budget; if you set one by hand, size it for a full directory sync. Revoking the key stops provisioning within five minutes and deactivates nobody."
        },
        {
          "type": "text",
          "content": "Endpoints (application/scim+json throughout):"
        },
        {
          "type": "table",
          "headers": [
            "Resource",
            "Methods",
            "Filters"
          ],
          "rows": [
            [
              "/Users",
              "GET (list), POST",
              "userName eq, externalId eq, active eq, emails.value eq"
            ],
            [
              "/Users/{id}",
              "GET, PUT, PATCH, DELETE",
              "—"
            ],
            [
              "/Groups",
              "GET (list), POST",
              "displayName eq, externalId eq"
            ],
            [
              "/Groups/{id}",
              "GET, PUT, PATCH, DELETE",
              "—"
            ],
            [
              "/ServiceProviderConfig, /ResourceTypes, /Schemas",
              "GET",
              "—"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Lists page with startIndex (1-based) and count (default 100, max 200) and answer a ListResponse. An unsupported filter is a 400 with scimType: \"invalidFilter\" — never a silent full list, which would make an IdP conclude a user doesn't exist and create a duplicate. Errors are RFC 7644 …:2.0:Error documents with a string status."
        },
        {
          "type": "text",
          "content": "What the resources mean here:"
        },
        {
          "type": "list",
          "items": [
            "A SCIM User is one org membership. Its id is the platform user id."
          ]
        },
        {
          "type": "text",
          "content": "Directory-owned attributes (externalId, userName as sent, names) are stored on the membership, never on the account: a tenant's directory must not be able to rewrite the email or username of someone who also belongs to another org. userName is therefore write-once — changing it is a 400 mutability; remove the user and provision the new address instead."
        },
        {
          "type": "list",
          "items": [
            "A SCIM Group is a group → role mapping rule — the same rows the editor"
          ]
        },
        {
          "type": "text",
          "content": "above writes. SCIM owns the group's name and members; it never sets roles. What a group is worth stays a decision made here by someone holding roles:manage, so a stolen SCIM key can move people between groups but cannot invent a group that grants admin. A group the directory pushes grants nothing until you map it."
        },
        {
          "type": "list",
          "items": [
            "Roles follow group membership through the same resolver JIT uses, and"
          ]
        },
        {
          "type": "text",
          "content": "SCIM-driven assignments are sync-owned: a role an admin granted by hand is never removed by a sync."
        },
        {
          "type": "text",
          "content": "The rules a sync runs into:"
        },
        {
          "type": "list",
          "items": [
            "Verified domains. A user can only be provisioned at an email whose domain"
          ]
        },
        {
          "type": "text",
          "content": "the org (or its account root) has verified under Settings → Domains. Anything else is a 400 invalidValue. Without this, knowing an address would be enough to staple a membership onto someone else's account."
        },
        {
          "type": "list",
          "items": [
            "Seats. Creating past the pooled seat limit is refused with a 403 whose"
          ]
        },
        {
          "type": "text",
          "content": "detail names the seat limit. There is no overage and nothing is half-provisioned. Reactivating (active: true) is charged the same way."
        },
        {
          "type": "list",
          "items": [
            "Deactivation is immediate. PATCH active:false or DELETE deactivates the"
          ]
        },
        {
          "type": "text",
          "content": "membership, drops the roles the directory granted, bumps tokenVersion and clears the refresh-session slots in the same transaction, and publishes the revocation — so every outstanding token fails on its next request against every service, not at expiry. DELETE keeps the membership row (it holds the audit trail, the hand-granted roles and the seat accounting) and is idempotent."
        },
        {
          "type": "list",
          "items": [
            "Never. The org owner is never deactivated or removed (transfer"
          ]
        },
        {
          "type": "text",
          "content": "ownership first — 403), and a platform administrator is never provisioned or touched at all."
        },
        {
          "type": "list",
          "items": [
            "Unmodelled attributes are ignored, not refused. Entra and Okta send phone"
          ]
        },
        {
          "type": "text",
          "content": "numbers and the enterprise-user extension unconditionally; a 400 there would stall a whole run over something that changes nothing here."
        },
        {
          "type": "list",
          "items": [
            "Rate limit. Per organization (600 requests/minute), in its own bucket —"
          ]
        },
        {
          "type": "text",
          "content": "a directory sync neither spends nor is throttled by the org's interactive API budget. An org that issues five SCIM keys still gets one sync budget."
        },
        {
          "type": "text",
          "content": "Entitlement, and what a downgrade does. SCIM rides the same sso entitlement as OIDC SSO and JIT — no separate add-on. After a downgrade the surface becomes removal-only, deliberately:"
        },
        {
          "type": "table",
          "headers": [
            "After a downgrade",
            ""
          ],
          "rows": [
            [
              "GET (any)",
              "works — an IdP must look a user up before it can deactivate them"
            ],
            [
              "PATCH active:false, DELETE /Users/{id}",
              "works — removing someone in the directory still removes their access"
            ],
            [
              "DELETE /Groups/{id}, removing group members",
              "works — these only ever remove access"
            ],
            [
              "create, update, reactivate, add group members, rename a group",
              "refused (403, detail explains)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "A PATCH that deactivates and changes an attribute is refused as a whole, so nothing is half-applied. The first refusal emails and in-app-notifies the org's owners and admins (throttled to once a day), because otherwise a downgraded org sees removals keep working while new hires silently stop appearing."
        },
        {
          "type": "text",
          "content": "Audit and metrics. Every change is audited — org.scim.user.create, .update, .activate, .deactivate, .delete, org.scim.group.create, .update, .members, .delete — recording which attributes moved, never their values. Every refusal is org.scim.refused with details.reason (seat_limit, not_entitled, invalid_filter, owner_protected, …). Metrics: platform_scim_requests_total{resource,operation,result} and platform_scim_errors_total{resource,operation,reason}."
        },
        {
          "type": "note",
          "content": "Validator note: the Okta and Microsoft Entra hosted SCIM validators need a publicly reachable endpoint and a live tenant, so running them is a manual pre-release step. Their documented request shapes are encoded as fixtures in platform/test/scim-protocol.test.ts so the parsing stays honest in CI."
        },
        {
          "type": "text",
          "content": "IdP setup walkthroughs (OIDC)"
        },
        {
          "type": "text",
          "content": "Each walkthrough registers one OIDC application per org in the identity provider, whitelists the org's callback URL, and copies the resulting values into the OrgIdpConfig fields (provider, clientId, clientSecret, and either discoveryUrl or Cognito's region + userPoolId). The engine requests scopes openid email profile and validates the returned id_token against the IdP's JWKS."
        },
        {
          "type": "text",
          "content": "The redirect / callback URL to whitelist — this is per-org, so it embeds the org id:"
        },
        {
          "type": "code",
          "content": "<OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback"
        },
        {
          "type": "text",
          "content": "for example https://ci.acme.com/auth/sso/2f9c…/callback. Copy it from the wizard's Service-provider values step (or GET /organization/:id/idp/sp-info → oidcRedirectUri) rather than typing it: it is computed from the deployment's public URL. A mismatch here is the most common cause of a failed SSO login."
        },
        {
          "type": "text",
          "content": "Okta (generic-oidc)"
        },
        {
          "type": "list",
          "items": [
            "Okta Admin → Applications → Create App Integration → OIDC - OpenID Connect → Web Application.",
            "Sign-in redirect URIs → add <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback. Grant type: Authorization Code.",
            "Assign the app to the users/groups who should reach this org.",
            "Copy Client ID and Client secret; the discovery URL is https://<your-okta-domain>/.well-known/openid-configuration.",
            "In the SSO config set provider: generic-oidc, clientId, clientSecret, discoveryUrl."
          ]
        },
        {
          "type": "text",
          "content": "Microsoft Entra ID (generic-oidc)"
        },
        {
          "type": "list",
          "items": [
            "Entra admin center → App registrations → New registration.",
            "Redirect URI → platform Web → <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback.",
            "Certificates & secrets → New client secret → copy the Value; copy the Application (client) ID from Overview.",
            "Discovery URL: https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration.",
            "Set provider: generic-oidc, clientId, clientSecret, discoveryUrl."
          ]
        },
        {
          "type": "text",
          "content": "Google Workspace (google)"
        },
        {
          "type": "list",
          "items": [
            "Google Cloud Console → Create Credentials → OAuth client ID → Web application (configure the consent screen first if prompted).",
            "Authorized redirect URIs → add <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback.",
            "Copy the Client ID/secret.",
            "Set provider: google, clientId, clientSecret — the discovery URL is well-known (https://accounts.google.com/.well-known/openid-configuration), so you don't enter one."
          ]
        },
        {
          "type": "note",
          "content": "Google is the one provider that can sign in without a verified domain. Google verifies domain ownership itself before it will issue identities for a Workspace domain, so the platform does not ask the org to prove it again. Every other IdP does have to: see the domain rule. Verify a domain anyway — without one, this connection is unreachable from the login page's domain-based \"Continue with single sign-on\", and SSO required cannot be switched on."
        },
        {
          "type": "text",
          "content": "Auth0 (generic-oidc)"
        },
        {
          "type": "list",
          "items": [
            "Auth0 Dashboard → Applications → Create Application → Regular Web Application.",
            "Settings → Allowed Callback URLs → add <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback.",
            "Copy Client ID and Client Secret; discovery URL is https://<your-tenant>.<region>.auth0.com/.well-known/openid-configuration.",
            "Set provider: generic-oidc, clientId, clientSecret, discoveryUrl."
          ]
        },
        {
          "type": "text",
          "content": "Keycloak (generic-oidc)"
        },
        {
          "type": "list",
          "items": [
            "Keycloak Admin → select the realm → Clients → Create client → type OpenID Connect, Client authentication: On (confidential).",
            "Valid redirect URIs → add <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback.",
            "Credentials tab → copy the client secret; the client id is the name you set.",
            "Discovery URL: https://<keycloak-host>/realms/<realm>/.well-known/openid-configuration.",
            "Set provider: generic-oidc, clientId, clientSecret, discoveryUrl."
          ]
        },
        {
          "type": "text",
          "content": "AWS Cognito (cognito)"
        },
        {
          "type": "list",
          "items": [
            "Cognito console → your User pool → App integration → Create app client (a confidential client with a secret).",
            "Hosted UI / Allowed callback URLs → add <OAUTH_CALLBACK_BASE_URL>/auth/sso/<orgId>/callback; enable the Authorization code grant and openid email profile scopes.",
            "Copy the app client id and secret, and note the pool's region and User pool ID.",
            "Set provider: cognito, clientId, clientSecret, region, userPoolId — do not set discoveryUrl; it's derived as https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration."
          ]
        },
        {
          "type": "note",
          "content": "Before enabling, verify ownership of your email domains (DNS TXT, under the org's domains settings) — SSO refuses sign-ins on unverified domains. Then run Test connection, enable the connection, and — if nobody in those domains should sign in any other way — switch on SSO required. Every IdP write requires an MFA-grade session and a strong step-up."
        },
        {
          "type": "text",
          "content": "SAML 2.0"
        },
        {
          "type": "text",
          "content": "For organizations whose identity provider speaks SAML rather than OIDC. It is the same sign-in path: the same GET /auth/sso/:orgId/authorize starts it, the same verified identity comes out, and the same checks decide whether that identity may become a session — the org's DNS-verified ownership of the email domain, issuer-bound account linking, no platform-administrator sign-in, the sso entitlement, and just-in-time membership when it is enabled. SAML rides that entitlement; it is not a separate add-on."
        },
        {
          "type": "text",
          "content": "Set it on Settings → Single Sign-On, under the same org:idp capability and step-up confirmation as the OIDC connection."
        },
        {
          "type": "text",
          "content": "What to give your identity provider"
        },
        {
          "type": "text",
          "content": "Every value is derived from your organization id, this deployment's public URL (OAUTH_CALLBACK_BASE_URL) and its SP keys, so they exist before the connection does. Copy them from the wizard (or GET /organization/:id/idp/sp-info):"
        },
        {
          "type": "table",
          "headers": [
            "",
            ""
          ],
          "rows": [
            [
              "Service-provider entity ID (Audience)",
              "https://<your-host>/api/auth/sso/<orgId>/saml/metadata"
            ],
            [
              "Assertion Consumer Service (ACS) URL",
              "https://<your-host>/api/auth/sso/<orgId>/saml/acs, binding HTTP-POST"
            ],
            [
              "Single Logout (SLO) URL",
              "https://<your-host>/api/auth/sso/<orgId>/saml/slo, bindings HTTP-Redirect and HTTP-POST"
            ],
            [
              "Metadata document",
              "GET the entity-ID URL — most IdPs import everything from it"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The metadata carries the ACS, both SLO bindings, WantAssertionsSigned=\"true\", AuthnRequestsSigned set to the org's choice, the SP signing certificate (always — the IdP needs it to verify our logout messages) and, only when the org has turned on encrypted assertions, the SP encryption certificate (several IdPs start encrypting the moment one is offered). Re-import it at the IdP after changing either switch. Sign both the response and the assertion."
        },
        {
          "type": "text",
          "content": "Service-provider keys"
        },
        {
          "type": "text",
          "content": "The SP signing and encryption keys are auto-generated once per deployment (two separate RSA-2048 keys, each with a self-signed X.509 certificate valid for ten years) the first time anything needs them, and persisted in the platform database (saml_sp_keys) with the private halves encrypted under SECRET_ENCRYPTION_KEY — the same envelope as IdP client secrets. Every replica reads the same keys, so the metadata never depends on which pod served it, and there is nothing to mount or configure on any deploy target. The keys are shared by every org on the deployment (they identify this service provider); trust is still per org, pinned by each IdP to the certificate it imported."
        },
        {
          "type": "text",
          "content": "To rotate them, delete the documents from saml_sp_keys and restart the platform replicas: fresh keys are minted on first use, and every org that relies on signed requests, single logout or encrypted assertions must re-import the SP metadata at its IdP. (Keys are cached per process for exactly that reason — a rotation is a deliberate, restart-bounded event, never something that happens underneath a live sign-in.)"
        },
        {
          "type": "text",
          "content": "What to configure here"
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "What it is"
          ],
          "rows": [
            [
              "Identity provider entity ID",
              "The IdP's entityID. Every assertion's Issuer must equal it, so one org's IdP can never mint an assertion another org's config accepts."
            ],
            [
              "Identity provider SSO URL",
              "The IdP's HTTP-Redirect single sign-on endpoint. Must be https."
            ],
            [
              "Identity provider single-logout URL",
              "Optional. The IdP's HTTP-Redirect SLO endpoint (https). Turns on single logout in both directions."
            ],
            [
              "Signing certificate(s)",
              "The IdP's signing certificate, PEM or bare base64. A list — see rotation. Up to three at once."
            ],
            [
              "Attribute mapping",
              "Which assertion attribute carries email, name and groups. Leave a field empty to try the common spellings (email/mail and the Entra/Shibboleth URI forms; displayName; groups). An email-shaped NameID is used when no email attribute is present."
            ],
            [
              "Sign AuthnRequests",
              "Sign each AuthnRequest (RSA-SHA256, HTTP-Redirect binding) with the deployment's SP signing key. Off by default; turn it on when the IdP requires signed requests. Logout messages are always signed."
            ],
            [
              "Identity provider encrypts assertions",
              "The IdP encrypts each assertion to the SP encryption certificate; it is decrypted here. When on, a response carrying a plaintext assertion is refused (SAML_ENCRYPTION_REQUIRED) — so a downgrade can't slip one past; when off, an encrypted one is refused (SAML_UNEXPECTED_ENCRYPTION)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Groups feed the same group → role mapping rules OIDC uses, normalised the same way (trimmed, case-insensitive, de-duplicated), so one rule set governs both protocols. The Google carve-out does not apply to SAML — groups come from a mapped attribute, not a token claim."
        },
        {
          "type": "text",
          "content": "Importing IdP metadata"
        },
        {
          "type": "text",
          "content": "Instead of typing the IdP's values, Import identity-provider metadata (in the SAML form) takes the IdP's metadata document three ways — its URL, pasted XML, or an uploaded .xml file — via POST /organization/:id/idp/metadata/import ({ url } or { xml }). It extracts the entityID, the HTTP-Redirect SingleSignOnService and SingleLogoutService locations (https only), and the signing certificates (KeyDescriptor use=\"signing\" or no use; encryption-only keys are ignored; at most three), and notes WantAuthnRequestsSigned. It pre-fills the form only — nothing is saved until the administrator reviews the values and saves them (with the usual step-up) — and is audited as org.idp.metadata.import."
        },
        {
          "type": "text",
          "content": "A metadata URL is fetched by the platform, so it goes through the same SSRF guard as webhook and OIDC-discovery fetches: https only; a host that is — or resolves to — a loopback, private, link-local, CGNAT or cloud-metadata address is refused; redirects are refused (a public URL can't bounce to an internal one); the fetch times out after 5 s; and the body is capped at 512 KB while it streams. A refused or failed fetch answers 502 SAML_METADATA_FETCH_FAILED (paste the XML instead); an unusable document answers 400 SAML_METADATA_INVALID."
        },
        {
          "type": "text",
          "content": "What an assertion has to satisfy"
        },
        {
          "type": "list",
          "items": [
            "Service-provider-initiated only. Sign-in must start at Pipeline Builder. A"
          ]
        },
        {
          "type": "text",
          "content": "response with no InResponseTo is refused: an unsolicited assertion is a login-CSRF and replay primitive, because nothing ties it to a browser that asked to sign in. The request id is additionally checked against one this deployment actually minted (held in the shared Redis, so the initiate and the assertion may land on different replicas). There is no IdP-initiated entry point to enable — starting from your IdP's app launcher will not work, by design."
        },
        {
          "type": "list",
          "items": [
            "Signed, by a certificate you configured. XML-DSig over both the response"
          ]
        },
        {
          "type": "text",
          "content": "and the assertion, verified against the org's trust list. The document's own KeyInfo is never trusted. With encryption on, the decrypted assertion must still carry its own valid signature."
        },
        {
          "type": "list",
          "items": [
            "Encrypted exactly when the org says so (see the switch above).",
            "Issued for this organization. Issuer must equal the configured entity ID"
          ]
        },
        {
          "type": "text",
          "content": "and the AudienceRestriction must name this org's SP entity ID — so an assertion minted for another service provider by the same IdP is refused."
        },
        {
          "type": "list",
          "items": [
            "Inside its validity window. NotBefore / NotOnOrAfter, with a small"
          ]
        },
        {
          "type": "text",
          "content": "clock-skew allowance (SAML_CLOCK_SKEW_MS, default 60 s) for ordinary NTP drift — not a way to accept stale assertions."
        },
        {
          "type": "list",
          "items": [
            "Used once. The assertion's ID is claimed in Redis until the assertion"
          ]
        },
        {
          "type": "text",
          "content": "expires, so the same assertion can never be presented twice, on any replica."
        },
        {
          "type": "text",
          "content": "Every refusal is audited (sso.saml.refused with a stable details.reason) and counted (platform_saml_signins_total{result}); a successful sign-in is a user.login with details.method = 'saml' and result=\"success\"."
        },
        {
          "type": "text",
          "content": "How the browser gets its session"
        },
        {
          "type": "text",
          "content": "SAML delivers its assertion by an IdP-driven form POST to the ACS — a server endpoint — so, unlike OIDC, the frontend never sees it. The ACS verifies the assertion, provisions the membership, and redirects to /auth/sso/:orgId/saml with a one-time, org-bound handoff; that page redeems it (POST /auth/sso/:orgId/saml/complete) and the session is minted there. No token ever travels through a URL, and the session records the browser that actually redeemed the handoff. A refused assertion redirects to the same page with an error code instead. The session is recorded with the IdP's NameID and the AuthnStatement's SessionIndex (saml_sessions, expiring with the refresh token), which is what single logout matches on."
        },
        {
          "type": "text",
          "content": "A RelayState carrying the dry-run marker is a test connection, not a sign-in: the ACS verifies it in dry-run mode and redirects to /auth/sso/:orgId/saml?test=… — never with a handoff."
        },
        {
          "type": "text",
          "content": "Single logout (SLO)"
        },
        {
          "type": "text",
          "content": "Available when the IdP's single-logout URL is configured."
        },
        {
          "type": "list",
          "items": [
            "Signing out of Pipeline Builder (SP-initiated). Before ending a session the"
          ]
        },
        {
          "type": "text",
          "content": "app asks POST /auth/sso/logout. When the session came from a SAML sign-in, the answer is a signed LogoutRequest redirect (RSA-SHA256, HTTP-Redirect) naming that sign-in's NameID and SessionIndex; the app ends the local session (POST /auth/logout) and then sends the browser to the IdP, which ends its own session and returns a LogoutResponse to our SLO URL. That response is verified — signature required, issuer pinned, InResponseTo must name the request we sent (consumed once) — and the browser lands on the sign-in page. With no SLO URL, or a session that didn't come from SAML, sign-out stays local (redirectUrl: null); a connection repointed at another IdP never gets a LogoutRequest for a session the old IdP issued."
        },
        {
          "type": "list",
          "items": [
            "Signing out at the IdP (IdP-initiated). The IdP sends a LogoutRequest to"
          ]
        },
        {
          "type": "text",
          "content": "GET|POST /auth/sso/:orgId/saml/slo. It must be signed on either binding (on the redirect binding the SigAlg + Signature query parameters are required — an unsigned one is refused even though the library alone would accept it), by a certificate on the org's trust list, from the org's IdP Issuer, inside its validity window, and each LogoutRequest id is honoured once (replay-guarded in Redis). Every platform session that SAML sign-ins of that NameID — narrowed to the SessionIndex when the IdP names one — opened in this org is revoked through the same helper \"sign out this device\" uses: the refresh-session slot is removed at once, so nothing can renew it, and the short-lived access token lapses within its TTL. The revoke runs in bounded batches (100 at a time, at most 1000 sessions per request) — the endpoint is unauthenticated by construction, so one signed message must not be able to turn into unbounded work; anything past the cap is recorded on the audit event (capped) and those sessions lapse with their own refresh window. The IdP then gets a signed LogoutResponse (Success, echoing RelayState) at its SLO URL; with none configured, the browser lands on the sign-in page."
        },
        {
          "type": "list",
          "items": [
            "A refused logout message revokes nothing, redirects to"
          ]
        },
        {
          "type": "text",
          "content": "/auth/sso/:orgId/saml?error=SAML_INVALID_LOGOUT, and is audited as a failure. Every SLO leg is audited as sso.saml.logout (details.direction sp / idp, sessionsRevoked) and counted (platform_saml_slo_total{direction,result}). SLO messages are accepted even while the connection is disabled or the org has lost its entitlement — ending sessions is always safe."
        },
        {
          "type": "text",
          "content": "Rotating the IdP signing certificate"
        },
        {
          "type": "text",
          "content": "The certificate field is a list, and that is the whole rotation story: while both the outgoing and the incoming certificate are listed, assertions signed by either verify, so nobody is locked out mid-cutover. Add the new certificate, let your IdP cut over, then remove the old one. Changes are audited (sso.saml.certificate.rotate, with fingerprints before and after and whether an overlap window is now open). Full procedure: secret rotation → IdP SAML signing certificates."
        },
        {
          "type": "text",
          "content": "SAML is not a step-up factor"
        },
        {
          "type": "text",
          "content": "Step-up needs a fresh re-authentication read back from the popup the provider redirects to, and a SAML assertion lands on a server-side ACS instead. A SAML-only account steps up with a passkey, an authenticator app, or a password; the step-up modal does not offer an SSO button for a SAML org, and a client that asks anyway is told so."
        },
        {
          "type": "text",
          "content": "IdP setup walkthroughs (SAML)"
        },
        {
          "type": "text",
          "content": "Start the wizard with SAML 2.0 and the matching preset: step 2 shows the SP values below with copy buttons, and the preset fills the attribute names. In every IdP: assign the application to the people (or groups) who should reach the org, and sign both the response and the assertion."
        },
        {
          "type": "text",
          "content": "Okta"
        },
        {
          "type": "list",
          "items": [
            "Okta Admin → Applications → Create App Integration → SAML 2.0.",
            "Single sign-on URL = the ACS URL (tick *Use this for Recipient URL and"
          ]
        },
        {
          "type": "text",
          "content": "Destination URL*); Audience URI (SP Entity ID) = the SP entity ID; Name ID format = EmailAddress, Application username = Email."
        },
        {
          "type": "list",
          "items": [
            "Attribute statements: email → user.email, displayName →"
          ]
        },
        {
          "type": "text",
          "content": "user.displayName. Group attribute statements: groups, filter e.g. Matches regex .* (or the groups you map). The Okta preset uses exactly these names."
        },
        {
          "type": "list",
          "items": [
            "Signing: Okta signs the assertion; under Show Advanced Settings set"
          ]
        },
        {
          "type": "text",
          "content": "Response to Signed as well. Signed requests: if you enable Signed Requests in Okta, upload our signing certificate (from the SP values) and turn on Sign AuthnRequests here."
        },
        {
          "type": "list",
          "items": [
            "Encryption (optional): Assertion Encryption → Encrypted, upload our"
          ]
        },
        {
          "type": "text",
          "content": "encryption certificate, then turn on Identity provider encrypts assertions."
        },
        {
          "type": "list",
          "items": [
            "Single logout: Enable Single Logout, Single Logout URL = our SLO URL,"
          ]
        },
        {
          "type": "text",
          "content": "SP Issuer = our entity ID, Signature Certificate = our signing certificate. Okta's SLO endpoint is then in its metadata."
        },
        {
          "type": "list",
          "items": [
            "On the app's Sign On tab copy the Metadata URL and paste it into"
          ]
        },
        {
          "type": "text",
          "content": "Import metadata → From URL. Review, save, then Test connection."
        },
        {
          "type": "text",
          "content": "Microsoft Entra ID"
        },
        {
          "type": "list",
          "items": [
            "Entra admin center → **Enterprise applications"
          ]
        },
        {
          "type": "text",
          "content": "→ New application → Create your own application → Integrate any other application (non-gallery)**."
        },
        {
          "type": "list",
          "items": [
            "Single sign-on → SAML → Upload metadata file with our SP metadata (or set"
          ]
        },
        {
          "type": "text",
          "content": "Identifier (Entity ID) = SP entity ID, Reply URL (ACS) = ACS URL, Logout URL = SLO URL by hand)."
        },
        {
          "type": "list",
          "items": [
            "Attributes & Claims: Entra sends email as"
          ]
        },
        {
          "type": "text",
          "content": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress and the name as http://schemas.microsoft.com/identity/claims/displayname; Add a group claim (security groups, Group ID or sAMAccountName) — it arrives as http://schemas.microsoft.com/ws/2008/06/identity/claims/groups. The Entra preset uses these names; map group object IDs (or names, if you chose those) in the role mappings."
        },
        {
          "type": "list",
          "items": [
            "Signing: under SAML Certificates → Edit, set Signing Option to"
          ]
        },
        {
          "type": "text",
          "content": "Sign SAML response and assertion. Entra accepts unsigned AuthnRequests; to require signed ones, turn on Verification certificates with our signing certificate and turn on Sign AuthnRequests here."
        },
        {
          "type": "list",
          "items": [
            "Encryption (optional): Token encryption → Import certificate (our"
          ]
        },
        {
          "type": "text",
          "content": "encryption certificate) and activate it, then turn on Identity provider encrypts assertions."
        },
        {
          "type": "list",
          "items": [
            "Single logout: the Logout URL (step 2) is our SLO URL; Entra's own"
          ]
        },
        {
          "type": "text",
          "content": "logout endpoint is in its metadata. Entra signs its logout messages with the same certificate."
        },
        {
          "type": "list",
          "items": [
            "Copy App Federation Metadata Url (SAML Certificates) into **Import"
          ]
        },
        {
          "type": "text",
          "content": "metadata → From URL. Review, save, then Test connection**."
        },
        {
          "type": "text",
          "content": "Google Workspace"
        },
        {
          "type": "list",
          "items": [
            "Google Admin console → **Apps → Web and mobile apps → Add app → Add custom"
          ]
        },
        {
          "type": "text",
          "content": "SAML app**."
        },
        {
          "type": "list",
          "items": [
            "Google Identity Provider details: Download metadata (keep the file).",
            "Service provider details: ACS URL = our ACS URL, Entity ID = our"
          ]
        },
        {
          "type": "text",
          "content": "SP entity ID, Name ID format = EMAIL, Name ID = Basic Information > Primary email; tick Signed response (Google always signs the assertion)."
        },
        {
          "type": "list",
          "items": [
            "Attribute mapping: email ← Primary email, name ← First name (or a"
          ]
        },
        {
          "type": "text",
          "content": "custom attribute), and under Group membership add the groups to send as groups. The Google Workspace preset uses these names."
        },
        {
          "type": "list",
          "items": [
            "Turn the app ON for the relevant organizational units.",
            "Signing / encryption / logout: Google Workspace neither verifies signed"
          ]
        },
        {
          "type": "text",
          "content": "AuthnRequests nor encrypts assertions, and has no single-logout endpoint — leave Sign AuthnRequests and encrypts assertions off and the SLO URL empty (sign-out then stays local to Pipeline Builder)."
        },
        {
          "type": "list",
          "items": [
            "Import metadata → Paste / upload the file from step 2. Review, save, then"
          ]
        },
        {
          "type": "text",
          "content": "Test connection."
        },
        {
          "type": "text",
          "content": "Two config surfaces"
        },
        {
          "type": "text",
          "content": "The same OrgIdpConfig is manageable from two places, which stay in lockstep (shared service, quota reservation, and audit actions):"
        },
        {
          "type": "table",
          "headers": [
            "Surface",
            "Who",
            "Where"
          ],
          "rows": [
            [
              "Superadmin / fleet",
              "Platform operators (Super Admin)",
              "/admin/org-idp — register or edit SSO for any org on their behalf (the \"IdP / SSO\" dashboard page)."
            ],
            [
              "Org-admin self-service",
              "An org's own admin",
              "Managed under the org's settings (Settings → Single Sign-On), gated on the org:idp capability — the customer's admin configures their own org's SSO, on either protocol, without an operator (GET/PUT/PATCH/DELETE /organization/:id/idp)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Both surfaces gate the secret-bearing writes behind step-up re-authentication, and the self-service surface additionally requires the org to be sso-entitled and only lets an admin touch their own org (or a team they manage). Every create / update / delete is recorded in the audit trail (admin.org-idp.upsert / admin.org-idp.delete)."
        },
        {
          "type": "text",
          "content": "On the self-service page a new connection is created with PUT (the full body its protocol needs); every later save is a PATCH carrying only the fields that changed, so saving the SAML side never re-sends the OIDC side or its secret. Disconnect SSO (DELETE) removes the connection outright — members fall back to their other sign-in methods (password, passkey, a linked social login); anyone who has only ever signed in through SSO has none until an administrator sets one. Each of the three is confirmed in one step-up dialog that takes a passkey or authenticator code, and removes the test result and the SSO-required policy with it. To pause SSO without losing the settings, switch it off (Enable single sign-on) instead."
        }
      ]
    },
    {
      "id": "step-up-re-authentication-every-account",
      "title": "Step-up re-authentication (every account)",
      "blocks": [
        {
          "type": "text",
          "content": "Sensitive actions — deleting an account or org, minting a PAT, rotating KMS, granting platform-admin, starting an impersonation, restoring soft-deleted data, writing an IdP secret — need a step-up: a fresh proof of identity in addition to the session, replayed as the X-Step-Up-Token header (60s, single-use, caller-bound). Step-up is factor-agnostic: every factor mints the same token, so the requireStepUp gate on every service is identical."
        },
        {
          "type": "table",
          "headers": [
            "Factor",
            "Endpoint",
            "Who has it"
          ],
          "rows": [
            [
              "Passkey",
              "POST /auth/step-up/webauthn/options → /verify",
              "Anyone who has added one. Offered first — it is the strongest of the four and takes a touch rather than a typed secret."
            ],
            [
              "Authenticator app",
              "POST /auth/step-up/totp { code }",
              "Anyone with a TOTP enrolment. Offered second: it proves possession of a device, and it is the one factor that works on a machine with no passkey. A recovery code satisfies it too."
            ],
            [
              "Password",
              "POST /auth/step-up { password }",
              "Accounts created with email + password."
            ],
            [
              "Provider re-auth",
              "POST /auth/step-up/reauth → POST /auth/step-up/reauth/callback",
              "Accounts with a linked social provider or org SSO — including the Google/GitHub/SSO accounts that have no password at all and previously could not pass step-up."
            ]
          ]
        },
        {
          "type": "text",
          "content": "GET /user/profile reports what the account has as authFactors (hasPassword, passkeyCount, hasTotp, providers[]), and the step-up dialog offers exactly those. The token records how it was earned (method: 'password' | 'webauthn' | 'totp' | 'reauth'), which is also in the audit event; a TOTP step-up additionally carries mfa in the token's amr. All four share ONE per-user budget of 5 attempts a minute — a limit that reset per factor would just be the loosest of them — and TOTP adds a per-account lockout on top, because a 6-digit code is small enough that a request limiter alone is not the real bound."
        },
        {
          "type": "text",
          "content": "How provider re-auth works"
        },
        {
          "type": "list",
          "items": [
            "The dialog calls POST /auth/step-up/reauth with the chosen provider"
          ]
        },
        {
          "type": "text",
          "content": "({ type: 'oauth', provider } or { type: 'sso', orgId }). It must be one of the account's own authFactors.providers, or the request is refused."
        },
        {
          "type": "list",
          "items": [
            "The server mints a single-use state (prefixed reauth., stored in the"
          ]
        },
        {
          "type": "text",
          "content": "shared Redis pending-state store, bound to the signed-in user, ≤5 min) and returns the provider authorize URL with the provider's \"sign in again\" parameters (OIDC prompt=login + max_age=0)."
        },
        {
          "type": "list",
          "items": [
            "The browser opens that URL in a popup. The provider redirects back to the"
          ]
        },
        {
          "type": "text",
          "content": "ordinary callback page (/auth/callback/:provider or /auth/sso/:orgId/callback), which recognizes the reauth. prefix, hands code + state to the window that opened it (same-origin only) and closes."
        },
        {
          "type": "list",
          "items": [
            "That window calls POST /auth/step-up/reauth/callback. Verification is the"
          ]
        },
        {
          "type": "text",
          "content": "same as sign-in — social code exchange + verified userinfo, or the SSO id_token (JWKS signature, issuer, audience, nonce, the org's verified-domain authority) — plus: the identity must be the one already linked to the account (provider subject, and issuer for SSO; never merely the same email), and the sign-in must be fresh (see below). Only then is the step-up token issued."
        },
        {
          "type": "text",
          "content": "Rate limits and auditing match the password path: 5 attempts/minute per user, failures as user.login.failed (targetType: 'step-up'), successes as user.step-up, and both counted in platform_step_up_total{method,outcome}. Read-only impersonation blocks these POSTs like any other write, and platform administrators can never step up through a tenant-run IdP (they can't sign in through one either)."
        },
        {
          "type": "text",
          "content": "Recency, per provider"
        },
        {
          "type": "text",
          "content": "The server checks the provider's auth_time claim against the moment the re-auth started (60s clock skew). What a provider can prove differs:"
        },
        {
          "type": "table",
          "headers": [
            "Provider",
            "Re-prompt sent",
            "Recency"
          ],
          "rows": [
            [
              "Generic OIDC / Cognito (org SSO)",
              "prompt=login + max_age=0",
              "Required — max_age obliges a conformant IdP to return auth_time; a missing claim is refused."
            ],
            [
              "Google (social or SSO)",
              "prompt=select_account + max_age=0",
              "Enforced only when Google returns auth_time. Google rejects prompt=login and does not honour max_age, so the account picker is the strongest re-prompt available."
            ],
            [
              "Microsoft, GitLab, LinkedIn",
              "prompt=login + max_age=0",
              "Enforced when the id_token carries auth_time."
            ],
            [
              "GitHub",
              "prompt=select_account",
              "Not available — GitHub is plain OAuth2 (no id_token, max_age or auth_time), so re-auth proves a live GitHub session for the linked account, not a fresh password entry."
            ],
            [
              "Facebook",
              "auth_type=reauthenticate",
              "Facebook re-prompts for the password but reports no auth_time, so recency isn't independently verifiable."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Where recency can't be proven the audit event records recencyVerified: false. Accounts that need the strongest step-up should add a passkey, whose assertion is always fresh."
        },
        {
          "type": "note",
          "content": "Operators: the re-auth popup reuses the sign-in redirect_uri you already registered — no new provider configuration. The SSO popup needs the frontend page at /auth/sso/:orgId/callback, which is the URL the IdP already has. Redis is what makes the state visible across platform replicas (see Environment Variables)."
        }
      ]
    },
    {
      "id": "passkeys-webauthn",
      "title": "Passkeys (WebAuthn)",
      "blocks": [
        {
          "type": "text",
          "content": "A passkey is a key pair the person's own device holds. Signing in proves possession of that device plus a local unlock (fingerprint, face, PIN), and the private half never leaves it — so there is nothing to phish, reuse or leak in a breach. Nothing needs configuring: a person adds one from Dashboard → Security → Factors → Passkeys and it works from then on."
        },
        {
          "type": "text",
          "content": "Passkeys do three jobs here:"
        },
        {
          "type": "list",
          "items": [
            "Sign in without a password, including from the browser's autofill dropdown.",
            "Step up before a sensitive action — the passkey path is offered first.",
            "Give the Google/GitHub/SSO accounts that have no password a factor of their"
          ]
        },
        {
          "type": "text",
          "content": "own, so they no longer depend on a provider round trip."
        },
        {
          "type": "text",
          "content": "Adding one"
        },
        {
          "type": "text",
          "content": "Enrolment is step-up gated, and step-up is factor-agnostic — so an account with a password re-enters it, and an account without one re-authenticates with its own provider. Either way the same token unlocks the ceremony, and that is how a first passkey gets added to a passwordless account."
        },
        {
          "type": "text",
          "content": "Enrolment and removal additionally require an interactive session: never an access key, never a scoped machine credential, and never an impersonated session, so an operator viewing an account can't leave a credential behind in it."
        },
        {
          "type": "text",
          "content": "Every passkey is created as discoverable (residentKey: required) with user verification required. Discoverable is what lets sign-in work before the person has typed anything; user verification is what makes the assertion a proof of who, not just of which device."
        },
        {
          "type": "text",
          "content": "Removing one"
        },
        {
          "type": "text",
          "content": "Refused (409) when it is the account's only way in — no password, no linked provider, no other passkey. The credential on the device itself is not deleted; that has to be done in the device's own settings."
        },
        {
          "type": "text",
          "content": "Signing in"
        },
        {
          "type": "text",
          "content": "The sign-in field carries autocomplete=\"username webauthn\", and where the browser supports conditional UI a challenge is armed on page load, so a returning user signs in by picking their account from the autofill dropdown. Browsers without conditional UI get the explicit Sign in with a passkey button; both paths end at the same endpoint and open the same session as a password sign-in (same issueTokens, same refresh cookie, amr: ['webauthn'])."
        },
        {
          "type": "text",
          "content": "Passkey sign-in obeys the same rules as password sign-in: refused for SSO-enforced domains (those users must go through their IdP), the same rate-limit posture, and one opaque 401 for every failure. Passkey step-up is still allowed for an SSO-enforced account — that person is already inside a session their IdP admitted."
        },
        {
          "type": "text",
          "content": "The relying party"
        },
        {
          "type": "text",
          "content": "The RP ID and the accepted origins come from configuration, never from the request: RP ID is the exact hostname of PLATFORM_FRONTEND_URL, and the default origin is its scheme + host + port. A Host:-derived RP would let anyone who can reach the service mint challenges for a domain of their choosing."
        },
        {
          "type": "note",
          "content": "The RP ID is permanent. Every passkey is bound to the value in force when it was registered; changing it orphans every credential already enrolled, with no migration. Platform refuses to boot on an IP-address RP ID, an origin outside the RP ID, or a plain-http origin other than http://localhost. See Environment Variables → Passkeys."
        },
        {
          "type": "text",
          "content": "Cloned-credential detection"
        },
        {
          "type": "text",
          "content": "Authenticators that count signatures must count up. A credential whose stored counter is above zero and comes back equal or lower means two authenticators are answering for one credential — a clone. The assertion is refused and user.passkey.clone_suspected is audited. Synced passkeys legitimately report 0 forever, so the check only applies once a credential has counted at least once."
        },
        {
          "type": "text",
          "content": "Approved authenticators (AAGUID allowlist)"
        },
        {
          "type": "text",
          "content": "An org admin (org:settings, step-up; widening or clearing the list also needs an aal: 2 session) can limit passkeys to specific authenticator models — Settings → Organization → Approved authenticators, or PATCH /organization/:id/authenticator-policy with { allowedAaguids: [...] }. Empty means any model. A parent org's list applies to its teams too; where both set one, only models on every list apply (strictest wins)."
        },
        {
          "type": "list",
          "items": [
            "Registration. While the registrant's active org (or an ancestor) has a"
          ]
        },
        {
          "type": "text",
          "content": "list, the ceremony asks for direct attestation, and the attestation is verified against the FIDO Metadata Service: SimpleWebAuthn is seeded with the MDS statements, so a known model's certificate chain is checked against that model's own roots. The registration is refused (WEBAUTHN_ATTESTATION_UNVERIFIABLE) when there is no attestation (none), only self attestation, a model MDS doesn't know, or no metadata loaded; and refused (WEBAUTHN_AUTHENTICATOR_NOT_ALLOWED) when the model isn't on the list or MDS reports it compromised. In practice that means hardware security keys or managed authenticators — consumer keychain passkeys usually can't prove their model. Everyone else keeps attestationType: 'none'."
        },
        {
          "type": "list",
          "items": [
            "Sign-in — it doesn't count, rather than being refused. A passkey whose"
          ]
        },
        {
          "type": "text",
          "content": "model isn't on the active org's list still signs its owner in, but counts as aal: 1 in that org, so it can't satisfy the org's MFA requirement (an org that enforces MFA then refuses the session at issuance, exactly as for a password alone). The model rides on the session slot and the check runs at the one issuance chokepoint, so refresh and switch-org re-apply it. Refusing outright was rejected: passkeys that predate the list would lock passkey-only accounts out of every org, including ones with no list, and leave them no way in to register a compliant model."
        },
        {
          "type": "list",
          "items": [
            "Lockout guard. Saving a list that would leave the saving admin without an"
          ]
        },
        {
          "type": "text",
          "content": "accepted factor in an org that enforces MFA is refused (AUTHENTICATOR_POLICY_LOCKOUT)."
        },
        {
          "type": "list",
          "items": [
            "Admin view. The read names each model from MDS, lists the models members"
          ]
        },
        {
          "type": "text",
          "content": "use today, and lists members whose passkeys the list in force would not accept (and whether they have an authenticator app to fall back on)."
        },
        {
          "type": "text",
          "content": "MDS is loaded lazily from FIDO_MDS_BLOB_PATH (air-gapped) or FIDO_MDS_URL, its signature chain verified against the FIDO root, and cached for FIDO_MDS_REFRESH_MS; a failed refresh keeps the previous snapshot (see environment variables)."
        },
        {
          "type": "text",
          "content": "What gets recorded"
        },
        {
          "type": "text",
          "content": "user.passkey.register (with details.aaguid and attestationVerified; a policy refusal is the same action with outcome: failure and the reason), user.passkey.rename, user.passkey.remove, user.passkey.clone_suspected and org.authenticator_policy.update (models added / removed); sign-in and step-up carry details.method: 'webauthn', and failures are user.login.failed with the refusal reason the caller is deliberately not told. A passkey counted as aal: 1 by a list increments platform_authenticator_policy_demotions_total."
        }
      ]
    },
    {
      "id": "authenticator-app-totp",
      "title": "Authenticator app (TOTP)",
      "blocks": [
        {
          "type": "text",
          "content": "A 6-digit code from an app on the person's phone (Google Authenticator, 1Password, Aegis, iOS Passwords, …), asked for after the password. It is the factor for people and devices without a passkey, and unlike a passkey it works from any machine the person signs in from."
        },
        {
          "type": "text",
          "content": "Like passkeys, it needs no operator configuration: a person turns it on from Dashboard → Security → Factors → Authenticator app."
        },
        {
          "type": "text",
          "content": "What it does"
        },
        {
          "type": "list",
          "items": [
            "Guards password sign-in. Once it is on, the password alone no longer"
          ]
        },
        {
          "type": "text",
          "content": "completes a sign-in (see below)."
        },
        {
          "type": "list",
          "items": [
            "Steps up before a sensitive action — offered second, after a passkey."
          ]
        },
        {
          "type": "text",
          "content": "The parameters are fixed"
        },
        {
          "type": "text",
          "content": "RFC 6238, SHA-1 / 6 digits / 30 seconds, with a ±1 step drift allowance. Not because they are the strongest available, but because they are the only combination every authenticator reads reliably from an otpauth:// URI — several silently ignore algorithm and digits, which produces an enrolment that scans cleanly and then never verifies. The secret is 160 random bits, so SHA-1's collision weakness is irrelevant: HMAC-SHA1's security rests on PRF strength, and the real bound is the 6-digit code plus the lockout."
        },
        {
          "type": "text",
          "content": "A wider drift window is the usual way TOTP gets weakened — every extra step is another live code to guess — so it stays at one, i.e. a code is good for at most 90 seconds."
        },
        {
          "type": "text",
          "content": "Turning it on"
        },
        {
          "type": "text",
          "content": "Enrolment is two steps, and is step-up gated plus restricted to an interactive session (never an API key, a scoped machine token, or an impersonated session — an operator viewing an account must not be able to leave a factor behind in it, or take one away):"
        },
        {
          "type": "list",
          "items": [
            "POST /auth/totp/enrol mints a secret and returns it once, as an"
          ]
        },
        {
          "type": "text",
          "content": "otpauth:// URI (rendered as a QR) and as a typed setup key. Nothing is protecting the account yet."
        },
        {
          "type": "list",
          "items": [
            "POST /auth/totp/activate takes a code from the app. Confirming with a real"
          ]
        },
        {
          "type": "text",
          "content": "code — rather than trusting the scan — is the point of the two-step flow: it proves the secret reached a working authenticator before the account starts depending on it. This is also where the recovery codes are minted."
        },
        {
          "type": "text",
          "content": "An enrolment abandoned halfway is simply replaced by the next one, with a new secret: the old one was displayed, so it must never be the one that ends up confirmed. Re-enrolling over a working authenticator is refused — silently rotating the secret under a live app is how people lock themselves out. Disable first (which takes its own step-up)."
        },
        {
          "type": "text",
          "content": "Refused for SSO-enforced addresses. When an org has verified the domain and turned SSO on, the identity provider owns the factors; a second, unmanaged MFA its admins can neither see nor revoke is worse than none."
        },
        {
          "type": "text",
          "content": "The secret at rest"
        },
        {
          "type": "text",
          "content": "Stored as an AES-256-GCM EncryptedBlob under SECRET_ENCRYPTION_KEY, with the key HKDF-derived for the owning user. A row lifted into another account's record fails its authentication tag, and a database dump without the master key yields nothing. The usertotps collection also hides the secret and the recovery hashes from ordinary reads (select: false), so a route that forgets a projection cannot leak either."
        },
        {
          "type": "text",
          "content": "Signing in"
        },
        {
          "type": "text",
          "content": "A password sign-in for an account with TOTP does not complete on the password:"
        },
        {
          "type": "list",
          "items": [
            "POST /auth/login verifies the password and answers"
          ]
        },
        {
          "type": "text",
          "content": "{ mfaRequired: true, challengeId, expiresAt } — no access token, no refresh cookie, no session slot. The sign-in is not audited as having happened."
        },
        {
          "type": "list",
          "items": [
            "POST /auth/mfa/verify { challengeId, code } opens the session the login"
          ]
        },
        {
          "type": "text",
          "content": "would have, with mfa added to amr."
        },
        {
          "type": "text",
          "content": "The challenge is 256 random bits naming a row in the shared Redis pending-state store, so it can be invalidated the instant it is spent. A wrong code does not burn it — a mistyped digit sending someone back to re-enter their password would push people towards weaker factors — but a correct one does, so one handle can never yield two sessions. Guessing is bounded twice: a per-challenge rate limit and the per-account lockout. The challenge expires after 5 minutes regardless."
        },
        {
          "type": "text",
          "content": "Every refusal is the same opaque 401 the password path gives, with the reason only in the audit trail — with two exceptions. SSO enforcement, re-checked on the second leg (an org can turn it on between the two), answers the same 403 SSO_REQUIRED naming the org. And an unknown or already-spent challenge answers 401 TOTP_INVALID_CHALLENGE: the handle is 256 unguessable bits, so saying it is gone is no oracle, and retrying a code against a dead challenge can only fail forever — the sign-in page sends the person back to the password field instead of asking for more codes."
        },
        {
          "type": "text",
          "content": "The CLI is unaffected: pipeline-manager auth login hands the sign-in to a browser through the device authorization grant, so it inherits whatever the account uses. docker login against the image registry is affected — Basic auth has nowhere to carry a code, so an account with TOTP is refused there and should push with an access key instead (docker login -u <anything> -p pb_pat_…)."
        },
        {
          "type": "text",
          "content": "Replay, drift and lockout"
        },
        {
          "type": "list",
          "items": [
            "A code and time step are spent once. Every acceptance records the step it"
          ]
        },
        {
          "type": "text",
          "content": "consumed, and the next verification accepts only a strictly greater one, claimed with a conditional update — so two concurrent uses of one code race and exactly one wins. That is what stops a phishing proxy replaying the code it just relayed, and it also rules out an earlier step still inside the drift window."
        },
        {
          "type": "list",
          "items": [
            "Repeated failures lock the account's TOTP out (TOTP_MAX_FAILURES"
          ]
        },
        {
          "type": "text",
          "content": "consecutive wrong codes, then TOTP_LOCKOUT_MS). It applies to sign-in and step-up alike, and recovery codes share the counter — guessing one does not earn a fresh budget. On the sign-in path a lockout answers the same opaque 401 as a wrong code (saying otherwise would confirm the password was right); on the step-up path, where the caller is already authenticated, it is a 429 with actionable wording."
        },
        {
          "type": "text",
          "content": "Recovery codes"
        },
        {
          "type": "text",
          "content": "Recovery codes belong to the account, not to this factor: one set per person (MfaRecoveryCodes, services/recovery-codes-service.ts), minted with the account's first second factor — a passkey or an authenticator app — and shown once. Adding a second factor keeps the same set, so nobody holds two sheets; POST /auth/totp/activate returns an empty list when a passkey already minted one. Only SHA-256 hashes are stored (a recovery code is 50 bits of uniform randomness nobody chose, so there is no dictionary for a work factor to slow down). They are accepted anywhere a generated code is — the sign-in exchange and the TOTP step-up — and, for a passkey-only account, on the recovery-only sign-in leg (below)."
        },
        {
          "type": "text",
          "content": "A spent code is kept and marked, so it is refused as spent rather than as unknown, and the settings page can say \"7 of 10 remaining\" (GET /auth/recovery-codes). Regenerating (POST /auth/recovery-codes, step-up + interactive session) replaces the whole set — \"some of these still work\" is not a state anyone can reason about — and needs a second factor to back up (409 RECOVERY_CODES_NO_FACTOR otherwise). The set is deleted when the account's last factor goes (and by an MFA reset): a recovery code with no factor to recover is a second password in disguise."
        },
        {
          "type": "text",
          "content": "Passkey-only accounts. A password sign-in for an account without an authenticator app normally opens an aal: 1 session. When the org's MFA policy refuses that session and the account still has unspent recovery codes, the login instead answers { mfaRequired: true, challengeId, methods: ['recovery'] }, and POST /auth/mfa/verify accepts only a recovery code for that challenge (password + recovery code = amr: ['pwd', 'mfa'], aal: 2, as with TOTP). Guessing on that leg is bounded by the set's own lockout (the same TOTP_MAX_FAILURES / TOTP_LOCKOUT_MS); with an authenticator app, recovery-code failures count against the enrolment's lockout instead, so the two never get separate budgets."
        },
        {
          "type": "text",
          "content": "Turning it off"
        },
        {
          "type": "text",
          "content": "DELETE /auth/totp (step-up gated, interactive session) removes the secret — and the account's recovery codes too when no passkey remains. Refused when it would leave the account with no way to sign in at all — the same guard that stops the last passkey from being removed, asked through the same helper so the two cannot disagree. TOTP is deliberately not counted as a way in by that guard: it is a second factor on a password sign-in, so an account holding only TOTP could not get in at all."
        },
        {
          "type": "note",
          "content": "Losing both. A person who loses their authenticator and their recovery codes cannot self-serve back in. Two admins of their organization can reset their factors — see Recovery when every factor is lost."
        },
        {
          "type": "text",
          "content": "Assurance"
        },
        {
          "type": "text",
          "content": "A TOTP-backed sign-in carries amr: ['pwd', 'mfa'] and reaches aal: 2; a TOTP step-up carries amr: ['stepup', 'mfa'] and method: 'totp', which is one of the two factors the most dangerous routes will accept. See Assurance levels and required MFA."
        },
        {
          "type": "text",
          "content": "What gets recorded"
        },
        {
          "type": "text",
          "content": "user.totp.enrol (twice — details.stage is started then activated), user.totp.disable, user.mfa.recovery_regenerate and user.mfa.recovery_used (details.context is login or step-up). Sign-in records details.method: 'pwd+totp' with details.via saying whether a generated or a recovery code was used; wrong codes are user.login.failed with details.method: 'totp', so brute-force shows up on the same trail as password guessing. Verifications are metered as platform_totp_verifications_total{stage,outcome} (stage is activate, stepup or login; outcome is success, recovery, failure or locked), step-ups also land in platform_step_up_total{method='totp',outcome}, and every issued sign-in challenge counts in platform_mfa_challenges_total — comparing it with the login successes is how a stuck second leg shows up."
        }
      ]
    },
    {
      "id": "assurance-levels-and-required-mfa",
      "title": "Assurance levels and required MFA",
      "blocks": [
        {
          "type": "text",
          "content": "Every session carries an authenticator assurance level (aal), and routes and organizations can demand a minimum."
        },
        {
          "type": "text",
          "content": "What the levels mean"
        },
        {
          "type": "table",
          "headers": [
            "aal",
            "How the session was opened"
          ],
          "rows": [
            [
              "1",
              "A password, a social sign-in (Google/GitHub/…), or SSO through an IdP the org has not marked as enforcing MFA."
            ],
            [
              "2",
              "A passkey asserted with user verification; a password plus an authenticator code (or a recovery code); or SSO through an IdP the org has marked as enforcing MFA."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The level is fixed when the session is opened and stored on its refresh-session slot alongside amr and auth_time. Refresh, renewal and switch-org copy it verbatim, so a refresh can never raise it — earning aal: 2 always means authenticating again, with a factor. That is why the UI answers an MFA_REQUIRED refusal with \"enrol, then sign in again\" rather than with a token refresh."
        },
        {
          "type": "text",
          "content": "Why the IdP setting is a per-org statement, not a claim we read. Most OIDC providers send no amr at all, and a SAML AuthnContextClassRef is whatever the IdP was configured to emit. The org administers its own provider, so its own statement is the best available evidence — idpEnforcesMfa on the org's two-factor settings. Leave it off unless the IdP genuinely requires a second factor."
        },
        {
          "type": "text",
          "content": "Requiring it on a route"
        },
        {
          "type": "code",
          "content": "router.post('/dangerous',\n  requireAuth({ minAssurance: 2 }),        // or: requireAuth, requireAssurance({ minAssurance: 2 })\n  requireStepUp({ methods: STRONG_STEP_UP_METHODS }),\n  handler);",
          "language": "ts"
        },
        {
          "type": "list",
          "items": [
            "minAssurance is about the session: a weaker one gets **401"
          ]
        },
        {
          "type": "text",
          "content": "MFA_REQUIRED. Adding maxAge (seconds) also bounds auth_time; a session that is strong but stale gets 401 REAUTH_REQUIRED**."
        },
        {
          "type": "list",
          "items": [
            "requireStepUp stays a per-action confirmation. Passing methods demands"
          ]
        },
        {
          "type": "text",
          "content": "that the confirmation was earned by a specific factor; a token earned another way is refused with 401 STEP_UP_METHOD_REQUIRED and is not consumed, so it can still be spent where it is accepted."
        },
        {
          "type": "list",
          "items": [
            "Machine credentials never satisfy minAssurance. An internal service"
          ]
        },
        {
          "type": "text",
          "content": "principal, an org service account and any exchanged access key (pb_pat_… / pb_sa_…) all get 403 HUMAN_SESSION_REQUIRED — there is no person behind them to have presented a factor. Point automation at a machine-facing route instead."
        },
        {
          "type": "text",
          "content": "Platform's own requireAuth reads MongoDB and takes no options, so it composes requireAssurance({ … }) after it; both call the same check."
        },
        {
          "type": "text",
          "content": "Where it is enforced today"
        },
        {
          "type": "text",
          "content": "There are two tiers. Always aal: 2 is for actions that weaken security or mint a long-lived machine credential, whatever the org's settings. By policy is for administrative actions that need aal: 2 only while the org's \"administrative actions require MFA\" policy is on (below)."
        },
        {
          "type": "table",
          "headers": [
            "Action",
            "Route(s)",
            "Tier",
            "Machine credentials"
          ],
          "rows": [
            [
              "Start / redeem / break-glass an impersonation session",
              "/admin/impersonate/*",
              "Always, + second-factor step-up",
              "403"
            ],
            [
              "Write a per-org KMS config",
              "/admin/orgs/:orgId/kms-config",
              "Always, + second-factor step-up",
              "403"
            ],
            [
              "Write an IdP config (self-serve or fleet)",
              "/organization/:id/idp, /admin/org-idp/:orgId",
              "Always, + second-factor step-up",
              "403"
            ],
            [
              "Grant / revoke platform-admin",
              "/admin/users/:id/grants",
              "Always, + second-factor step-up",
              "403"
            ],
            [
              "Loosen the org MFA policy (require-MFA off, admin-actions policy off, \"our IdP enforces MFA\" on)",
              "PATCH /organization/:id/mfa-policy",
              "Always, checked in the handler — turning a requirement on stays open to aal: 1",
              "403"
            ],
            [
              "Loosen the impersonation policy (less strict mode, self-approval on)",
              "PATCH /organization/:id/impersonation-policy",
              "Always, checked in the handler — tightening stays open",
              "403"
            ],
            [
              "Create a service account / issue its key",
              "POST /organization/:id/service-accounts, …/:accountId/keys",
              "Always, + step-up — with ONE exemption, the bootstrap-administrator window (assurance_exempted_total{reason=\"bootstrap-setup\"})",
              "403"
            ],
            [
              "Transfer ownership",
              "PATCH /organization/:id/transfer-owner",
              "Always, + step-up",
              "403"
            ],
            [
              "Edit / delete / re-entitle another user (sysadmin)",
              "PUT/DELETE /users/:id, PUT /users/:id/features, POST /users/bulk-delete",
              "Always, + step-up",
              "403"
            ],
            [
              "Request / approve an MFA reset; sysadmin direct reset",
              "/organization/:id/mfa-resets, /admin/users/:id/mfa-reset",
              "Always, + step-up (approval & direct: second-factor step-up)",
              "403"
            ],
            [
              "Roles: create / update / delete, add / remove members",
              "/organization/:id/roles…",
              "By policy",
              "allowed"
            ],
            [
              "IdP group → Role mappings",
              "/organization/:id/idp/group-mappings…",
              "By policy",
              "allowed"
            ],
            [
              "Members: add, bulk-add, remove, deactivate, activate",
              "/organization/:id/members…",
              "By policy",
              "allowed"
            ],
            [
              "Invitations: send, revoke, resend",
              "/invitation/send, /invitation/:id…",
              "By policy",
              "allowed"
            ],
            [
              "Billing: subscription create / update / cancel / reactivate, checkout, portal, add-ons, discounts, Marketplace claim",
              "api/billing",
              "By policy",
              "allowed"
            ],
            [
              "Log export",
              "GET /observability/logs/export",
              "By policy",
              "allowed"
            ],
            [
              "Create an access key; open a machine credential",
              "POST /user/keys, POST /user/generate-token",
              "By policy",
              "refused (403 HUMAN_SESSION_REQUIRED)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Loosening checks live in the handlers because the route table can't say \"only in one direction\"; they call refuseWeakSession, the handler-level twin of requireAssurance, so the refusals are identical. generate-token applies the policy only when opening a new machine credential — renewing an existing one (the unattended renewal) is exempt, or enabling the policy would stop every stored credential renewing."
        },
        {
          "type": "text",
          "content": "Administrative actions require MFA"
        },
        {
          "type": "text",
          "content": "A second org policy, separate from \"require MFA\" (which is about signing in): with adminActionsRequireMfa on, the \"by policy\" actions above need a session opened with a second factor, even while members may still sign in with a password alone. Set on the same card and route (PATCH /organization/:id/mfa-policy, { adminActionsRequireMfa }); turning it on is allowed at aal: 1, turning it off needs aal: 2."
        },
        {
          "type": "list",
          "items": [
            "How the services learn it. They can't read the org document, so it rides"
          ]
        },
        {
          "type": "text",
          "content": "the token: when the policy is on, token issuance stamps org_admin_aal: 2 on the session (and on exchanged access-key tokens). api-core's requireOrgAdminAssurance({ machines }) reads the claim and refuses an aal: 1 session with 401 MFA_REQUIRED (details.reason: 'org_admin_policy') — the same code the dashboard already turns into the enrol / sign-in-again dialog. With the policy off, the gate is a no-op."
        },
        {
          "type": "list",
          "items": [
            "Machine credentials are decided per route (machines: 'allow' | 'refuse',"
          ]
        },
        {
          "type": "text",
          "content": "recorded in the route table as orgAdminAssurance). Routes automation legitimately drives (members, roles, group mappings, invitations, billing, log export) allow them — the policy is about how strongly a person's session was opened. Minting a further credential (POST /user/keys, opening a machine credential via generate-token) refuses them with 403 HUMAN_SESSION_REQUIRED. Service-account tokens don't carry the claim."
        },
        {
          "type": "list",
          "items": [
            "Inheritance. A parent org's setting applies to its teams (strictest wins),"
          ]
        },
        {
          "type": "text",
          "content": "exactly like \"require MFA\"; the settings card names the parent. The claim is evaluated for the session's active org."
        },
        {
          "type": "list",
          "items": [
            "Refresh. Every token issuance path (sign-in, refresh, renewal,"
          ]
        },
        {
          "type": "text",
          "content": "switch-org, key exchange) re-resolves the policy, so the claim settles within one access-token lifetime on its own. Turning the policy on doesn't wait: it bumps tokenVersion for every active member of the org and of its teams — except the admin who saved it — and publishes the new versions, so a single-factor session can't keep acting as an admin on a stale claim; those members sign in again. (The saver's own access token keeps the old claim until it next refreshes.) Turning it off signs nobody out: a stale token then carries the stricter claim, which lapses at its next refresh. The write response and the org.mfa_policy.update audit event report sessionsRefreshed whenever the setting changed (0 when it was turned off)."
        },
        {
          "type": "text",
          "content": "Requiring it for an organization"
        },
        {
          "type": "text",
          "content": "Settings → Organization → Two-factor authentication (needs org:settings, and the save is step-up gated because turning it off removes a control for every member)."
        },
        {
          "type": "list",
          "items": [
            "Enforced when a token is issued, never per route: a session scoped to the"
          ]
        },
        {
          "type": "text",
          "content": "org is minted at aal: 2 or refused. It therefore covers every route of every service, including ones added later."
        },
        {
          "type": "list",
          "items": [
            "The token carries an mfaRequired claim, so no service looks the policy up.",
            "A grace period (14 days by default, 0–90) follows turning it on. During it"
          ]
        },
        {
          "type": "text",
          "content": "members are told — a banner with the deadline, and the enrolment link — but not refused. The deadline is computed server-side from a day count, so a client can never post one of its own, including one in the past."
        },
        {
          "type": "list",
          "items": [
            "The requirement is inherited: a parent org's requirement applies to its"
          ]
        },
        {
          "type": "text",
          "content": "teams, and a team cannot opt out of it (it may add one of its own)."
        },
        {
          "type": "list",
          "items": [
            "Loosening needs aal: 2. Turning it off (or stating that the org's IdP"
          ]
        },
        {
          "type": "text",
          "content": "enforces MFA) from a single-factor session is refused 401 MFA_REQUIRED; turning it on never is, so an admin without MFA can still adopt it."
        },
        {
          "type": "list",
          "items": [
            "Per-user reset grace. A person whose factors were reset"
          ]
        },
        {
          "type": "text",
          "content": "(below) is exempt from the requirement — own or inherited — until their mfaResetGraceUntil, so they can sign in and enrol; nobody else is. Enrolling a factor ends the grace early."
        },
        {
          "type": "list",
          "items": [
            "Once the grace ends, an aal: 1 session stops being re-issued: sign-in,"
          ]
        },
        {
          "type": "text",
          "content": "refresh, switch-org and generate-token all answer 401 MFA_REQUIRED. Scoped machine credentials (reporting:ingest and friends) are exempt — they are not a person's session, and they are already refused by every minAssurance gate."
        },
        {
          "type": "text",
          "content": "Asking an account with no factor at all"
        },
        {
          "type": "text",
          "content": "The banner above fires on an org policy deadline, so a member of an org that does not require MFA was never asked to protect their own account. A second, quieter prompt covers them: \"Your account is protected by a password alone\", with a link into passkey enrolment."
        },
        {
          "type": "text",
          "content": "There is deliberately no \"enable MFA\" setting behind it, for the person or for an admin. Whether an account is protected is derived from the factors it holds; a boolean beside them could only ever disagree with them, and would collide with the org policy's grace deadline and strictest-wins inheritance. Enrolling is the enable, and removing the last factor is the disable."
        },
        {
          "type": "list",
          "items": [
            "Shown only when the account holds no passkey and no confirmed authenticator,"
          ]
        },
        {
          "type": "text",
          "content": "the org-policy banner is not already showing (the two never stack), nothing is suppressing it, and the session is not a read-only impersonation — an operator cannot enrol for someone else, and must not answer for them either."
        },
        {
          "type": "list",
          "items": [
            "\"Not now\" hides it for 7 days, and \"Don't ask again\" until the"
          ]
        },
        {
          "type": "text",
          "content": "person reverses it on Security → Factors. Both are stored on the account (POST /user/mfa-prompt/snooze, POST /user/mfa-prompt/decline, DELETE /user/mfa-prompt — own-account, authenticated, no step-up: postponing a question weakens nothing). Server-side rather than in the browser, because a prompt that returns at the next sign-in is what teaches people to dismiss banners unread. The snooze deadline is computed server-side, like the org grace period."
        },
        {
          "type": "list",
          "items": [
            "Enrolling clears both, so removing that factor later prompts the person"
          ]
        },
        {
          "type": "text",
          "content": "again instead of leaving a decline to outlive it. GET /user/profile also reports the state only while the account has no factor."
        },
        {
          "type": "list",
          "items": [
            "The decline and its reversal are audited (user.mfa.prompt_declined,"
          ]
        },
        {
          "type": "text",
          "content": "user.mfa.prompt_restored); the snooze is not. An org's admins see the count of members who declined next to the enrolment count on the two-factor policy panel — the difference between people who haven't got round to it and people who have decided not to. A count, never a list of names."
        },
        {
          "type": "list",
          "items": [
            "The bootstrap administrator (below) is prompted too — they are exactly who"
          ]
        },
        {
          "type": "text",
          "content": "should enrol first — but with no \"not now\": their session may reach enrolment, sign-out and the setup routes and nothing else, so the prompt says that instead of offering a postponement it could not honour."
        },
        {
          "type": "text",
          "content": "The bootstrap-administrator exception"
        },
        {
          "type": "text",
          "content": "A fresh install has exactly one administrator and no enrolled factor, so requiring MFA would lock out the only person who can enrol one. The exception is narrow, self-closing and audited:"
        },
        {
          "type": "list",
          "items": [
            "It applies only to an account whose email is in BOOTSTRAP_SUPERADMIN_EMAILS"
          ]
        },
        {
          "type": "text",
          "content": "and which belongs to the system org, while User.mfaBootstrapClosedAt is unset and it has no factor."
        },
        {
          "type": "list",
          "items": [
            "Their password sign-in opens a real session, flagged mfaEnrollmentPending and"
          ]
        },
        {
          "type": "text",
          "content": "aal: 1, that can reach only enrolment, sign-out and the routes init-platform.sh calls (read the org and its roles, create the setup service account, issue and revoke its keys). Every other service refuses such a token outright with 403 MFA_ENROLLMENT_REQUIRED; the dashboard sends them straight to Security → Factors."
        },
        {
          "type": "list",
          "items": [
            "Two of those setup routes — creating the setup service account and issuing its"
          ]
        },
        {
          "type": "text",
          "content": "key — are also always aal: 2 routes, which this session can never be: the install has no factor to be MFA-grade with yet. So the assurance gate carries one named exemption, bootstrap-setup, which requires the mfaEnrollmentPending flag, a path the allowlist already admits, AND a live re-read (resolveBootstrapSetupWindow) confirming that the install is still inside BOOTSTRAP_SETUP_WINDOW_MS (default 24 h) and that the exception has not already closed. The live re-read matters because mfaEnrollmentPending is a token claim that outlives what it describes: enrolment clears it from the refresh slots, but an access token already issued keeps it for the rest of its ~15-minute life, and would otherwise still mint a durable superadmin key at aal: 1. It grants no extra reach, step-up still applies (the admin's password earns it), the action is still audited as org.service-account.create / .key.create, every use increments assurance_exempted_total{reason=\"bootstrap-setup\"}, a refusal increments platform_mfa_bootstrap_setup_refused_total{reason}, and the generated route table records it as aal2(except bootstrap-setup). Without it a fresh install could not finish: init would stop at 401 MFA_REQUIRED, and nothing else the bootstrap session can reach would let it proceed."
        },
        {
          "type": "list",
          "items": [
            "Only this credential-minting half is time-bounded. Reach — enrolment,"
          ]
        },
        {
          "type": "text",
          "content": "sign-out, refresh — is never bounded, so an admin who comes back to a long-neglected install is never locked out; they are only asked to enrol a factor before minting machine credentials. Past the window, re-run init-platform.sh after enrolling."
        },
        {
          "type": "list",
          "items": [
            "It closes permanently at the first enrolment of any factor and never"
          ]
        },
        {
          "type": "text",
          "content": "reopens, even if that factor is later removed."
        },
        {
          "type": "list",
          "items": [
            "System-org \"require MFA\" cannot be turned on while it is open — doing so"
          ]
        },
        {
          "type": "text",
          "content": "would refuse the only account that can close it (409 MFA_BOOTSTRAP_STILL_OPEN)."
        },
        {
          "type": "list",
          "items": [
            "SSO enforcement never applies to a bootstrap admin. SSO refuses"
          ]
        },
        {
          "type": "text",
          "content": "superadmins, so a verified, SSO-enforced domain matching their address would otherwise close both sign-in paths."
        },
        {
          "type": "list",
          "items": [
            "Every exception sign-in writes auth.mfa.bootstrap_session and increments"
          ]
        },
        {
          "type": "text",
          "content": "platform_mfa_bootstrap_session_total{late}. A fresh install finishes in minutes, so late=\"true\" — more than 24 hours after the system org was created — fires the MfaBootstrapSessionLate alert."
        },
        {
          "type": "text",
          "content": "Recovery when every factor is lost"
        },
        {
          "type": "text",
          "content": "Recovery is never self-service — anything that removed a factor on request would be a way around it. Instead it takes two people who each hold a factor, over HTTP, with no database access (services/mfa-recovery.ts, controllers/mfa-reset.ts):"
        },
        {
          "type": "list",
          "items": [
            "Request. An owner/admin of the member's org (or of a parent org) files a"
          ]
        },
        {
          "type": "text",
          "content": "request with a reason — Members → a member's row → Reset MFA…: POST /organization/:id/mfa-resets { userId, reason } (members:manage, aal: 2, step-up). Refused for oneself (MFA_RESET_SELF), for a platform administrator (MFA_RESET_PLATFORM_ADMIN — that is the operator path), for a non-member, and while another request for the same member is pending (one pending request per member per org is a unique index)."
        },
        {
          "type": "list",
          "items": [
            "Approve. A different owner/admin of that org or of an ancestor, or a"
          ]
        },
        {
          "type": "text",
          "content": "sysadmin, approves it from Pending two-factor resets on the Members page: POST /organization/:id/mfa-resets/:requestId/approve { graceHours? } (aal: 2 + a second-factor step-up). Neither the requester nor the member can approve (MFA_RESET_SECOND_PERSON_REQUIRED) — enforced in the same atomic update that moves the request out of pending, so a race or a retry can't approve twice. A request expires after 24 hours (410 MFA_RESET_EXPIRED). …/deny { note? } denies it (or, by its requester, withdraws it); it needs no step-up. GET /organization/:id/mfa-resets lists pending and recent requests for the org and its teams."
        },
        {
          "type": "list",
          "items": [
            "The reset removes every passkey, the authenticator app and the recovery"
          ]
        },
        {
          "type": "text",
          "content": "codes; bumps tokenVersion and clears every refresh-session slot (every session ends, everywhere); and grants a per-user enrolment grace (User.mfaResetGraceUntil, 72 hours by default, at most 168). Token issuance honours it against the org's \"require MFA\" policy — own or inherited — for that person only, so they can sign in with their password and enrol. The org's policy is never changed. The dashboard banner tells them the deadline; enrolling ends the grace."
        },
        {
          "type": "text",
          "content": "Single-admin orgs. A sysadmin can reset directly — Users → Reset MFA: POST /admin/users/:id/mfa-reset { reason, graceHours? } (sysadmin, aal: 2, second-factor step-up). Audited as auth.mfa.direct_reset with details.direct: true; it supersedes any pending request for the person."
        },
        {
          "type": "text",
          "content": "When nobody can sign in (the only admin of the only org, or every sysadmin locked out), the operator command runs the same reset with database access, inside a platform container. Its operator name is self-asserted:"
        },
        {
          "type": "code",
          "content": "docker compose exec platform node scripts/mfa-recover.js --email admin@internal --operator you@example.com\nkubectl exec -n pipeline-builder deploy/platform -- \\\n  node scripts/mfa-recover.js --email admin@internal --operator you@example.com --grace-hours 24",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "It writes auth.mfa.operator_reset (details.operatorAsserted: true, details.graceUntil) and, like every path, does not reopen the bootstrap exception."
        },
        {
          "type": "text",
          "content": "People are told this on the sign-in page, at the two points where they hit the dead end, so the request reaches an operator instead of a support queue:"
        },
        {
          "type": "list",
          "items": [
            "The code step names the recovery code in its copy (not only in the field's"
          ]
        },
        {
          "type": "text",
          "content": "placeholder) and carries a folded-away \"Lost your phone and your codes?\" panel explaining that no self-service route exists and who can reset the factors (two admins; a sysadmin for a one-admin org; the operator command when nobody can sign in)."
        },
        {
          "type": "list",
          "items": [
            "A sign-in refused by the org policy (401 MFA_REQUIRED — the grace period has"
          ]
        },
        {
          "type": "text",
          "content": "passed and the account has no usable factor) gets its own panel instead of a red error: the password was right and nothing they can retype will help. It points at the passkey button (a passkey satisfies the requirement on its own), at the recovery codes, and at the two-admin reset."
        },
        {
          "type": "text",
          "content": "What gets recorded"
        },
        {
          "type": "text",
          "content": "auth.mfa.bootstrap_session (every exception sign-in; details.late), auth.mfa.bootstrap_closed (the first enrolment closed it), auth.mfa.reset_requested / auth.mfa.reset_approved / auth.mfa.reset_denied (the two-person reset, each under the real signed-in actor; the approval also records the requester, what was removed and the grace), auth.mfa.direct_reset (a sysadmin's single-person reset), auth.mfa.operator_reset (the recovery command, operator self-asserted) and org.mfa_policy.update (both sides of each transition, plus sessionsRefreshed). Refusals are metered as platform_mfa_enforcement_refused_total{reason} on platform and mfa_enforcement_refused_total{service,reason} elsewhere — reason is weak_session, stale_session, machine_principal, bootstrap_session, or org_admin_weak_session / org_admin_machine_principal for the admin-actions policy. Policy changes count in platform_mfa_policy_changes_total{requireMfa}; resets in platform_mfa_resets_total{stage}."
        }
      ]
    },
    {
      "id": "switching-organizations-and-parent-admin-access-to-teams",
      "title": "Switching organizations and parent-admin access to teams",
      "blocks": [
        {
          "type": "text",
          "content": "A session is scoped to ONE organization at a time; POST /auth/switch-org ({ organizationId }) re-issues the current session's tokens — same refresh-session slot, same assurance — scoped to another org. The caller may switch into an org when they hold authority there, resolved by one rule (platform/src/helpers/org-authority.ts) that switch-org, token issuance and the refresh path all apply, so the three can never disagree:"
        },
        {
          "type": "list",
          "items": [
            "A membership — an active UserOrganization row in that org. The session"
          ]
        },
        {
          "type": "text",
          "content": "gets that row's role and the permissions of the Roles held there."
        },
        {
          "type": "list",
          "items": [
            "Admin authority inherited from an ancestor — an active admin or owner"
          ]
        },
        {
          "type": "text",
          "content": "membership in a live parent (the same rule canAdministerOrg applies to a request made from the parent). This is how a root-org admin \"opens\" one of its teams without being on the team:"
        },
        {
          "type": "list",
          "items": [
            "the session's role in the team is admin, never owner — ownership is a"
          ]
        },
        {
          "type": "text",
          "content": "designation of one org and is not conferred downward;"
        },
        {
          "type": "list",
          "items": [
            "its permissions are the parent Roles' bundle (the authority actually held),"
          ]
        },
        {
          "type": "text",
          "content": "unioned with any Roles the person also holds in the team;"
        },
        {
          "type": "list",
          "items": [
            "nothing is written: no membership row appears on the team's roster, no"
          ]
        },
        {
          "type": "text",
          "content": "seat is consumed, and the authority lasts only while the parent membership qualifies — removal or demotion bumps tokenVersion, and the next issuance re-resolves it;"
        },
        {
          "type": "list",
          "items": [
            "a direct admin/owner row in the team wins outright; a direct plain"
          ]
        },
        {
          "type": "text",
          "content": "member row loses to the inherited admin (otherwise a parent admin sitting on a team as a member would have less authority inside it than over it)."
        },
        {
          "type": "text",
          "content": "Authority never flows UP (a team admin gets nothing in the parent) or ACROSS (separate accounts still require a membership). A soft-deleted org can never be switched into, and a soft-deleted parent confers nothing. When the team is later soft-deleted or moved, every session scoped to it — members and inherited sessions alike (found by lastActiveOrgId) — is invalidated."
        },
        {
          "type": "text",
          "content": "GET /user/organizations lists the membership rows first, then one row per live team the caller may open on inherited authority, marked viaAncestor: true with role: 'admin'; each team row carries parentOrgName. The switch is audited as org.switch; an inherited-authority switch adds details.via: 'ancestor' and details.inheritedFromOrgId."
        }
      ]
    },
    {
      "id": "domain-based-org-join-p2b",
      "title": "Domain-based org join (P2b)",
      "blocks": [
        {
          "type": "text",
          "content": "Separate from SSO, an org can let people with a verified company email domain discover and join it — so coworkers land in one org instead of many one-person orgs. Requires the Team or Enterprise tier. The design and threat model are covered in the sections below."
        },
        {
          "type": "text",
          "content": "Admin setup (Settings → Domain-based join)"
        },
        {
          "type": "list",
          "items": [
            "Register the domain (e.g. acme.com). Public/freemail domains"
          ]
        },
        {
          "type": "text",
          "content": "(gmail.com, …) are rejected."
        },
        {
          "type": "list",
          "items": [
            "Verify ownership — publish the shown DNS TXT record, then click Verify:"
          ]
        },
        {
          "type": "text",
          "content": "_pipeline-builder-verify.acme.com TXT \"pb-verify=<token>\"  The platform resolves the record (bounded timeout) and, on match, marks the domain verified. First org to verify a domain owns it."
        },
        {
          "type": "list",
          "items": [
            "Choose who can join for the verified domain:",
            "Off — registered but not discoverable (default).",
            "Request — matching signups may request; an admin approves in the same"
          ]
        },
        {
          "type": "text",
          "content": "panel (Approve / Deny)."
        },
        {
          "type": "list",
          "items": [
            "Auto — matching signups join immediately as a member (use only for a"
          ]
        },
        {
          "type": "text",
          "content": "domain you fully control)."
        },
        {
          "type": "text",
          "content": "What the joining user sees"
        },
        {
          "type": "text",
          "content": "On first sign-in, the onboarding screen shows a \"Join your team\" section listing discoverable orgs for their verified email domain. Auto joins in one click; Request files a request an admin reviews. Discovery is verified-email-gated and only ever shows the user's own domain's orgs."
        },
        {
          "type": "text",
          "content": "Behavior worth knowing"
        },
        {
          "type": "list",
          "items": [
            "Seats: an auto-join or approval consumes a seat and is rejected if the"
          ]
        },
        {
          "type": "text",
          "content": "account is at its seat cap."
        },
        {
          "type": "list",
          "items": [
            "Removed users can't silently rejoin an auto domain — the join falls back"
          ]
        },
        {
          "type": "text",
          "content": "to a request for an admin to approve."
        },
        {
          "type": "list",
          "items": [
            "Denied requests are sticky (a user can't re-spam); an admin re-opens.",
            "Turning a domain off / deleting it denies its pending requests; deleting the"
          ]
        },
        {
          "type": "text",
          "content": "org frees the domain for anyone to register."
        },
        {
          "type": "list",
          "items": [
            "Every action is audited (org.domain., org.join.).",
            "Notifications: admins get an email + an in-app inbox message (live) on a new"
          ]
        },
        {
          "type": "text",
          "content": "request; the requester is notified (email + in-app) on approve/deny."
        },
        {
          "type": "list",
          "items": [
            "Verified domains are periodically re-checked; if the DNS TXT proof is"
          ]
        },
        {
          "type": "text",
          "content": "definitively removed, the domain is auto-un-verified and its join disabled."
        }
      ]
    },
    {
      "id": "how-tokens-are-signed-and-who-can-sign-one",
      "title": "How tokens are signed (and who can sign one)",
      "blocks": [
        {
          "type": "text",
          "content": "Only platform signs tokens that speak for a person. Access, refresh, step-up and the short-lived token an access key is exchanged for are all ES256 (ECDSA on NIST P-256), signed with a key platform alone holds, and each carries a kid naming the key that signed it."
        },
        {
          "type": "text",
          "content": "Everyone else verifies against the public halves, published unauthenticated at:"
        },
        {
          "type": "code",
          "content": "GET /.well-known/jwks.json      →  { \"keys\": [ { \"kty\":\"EC\", \"crv\":\"P-256\", \"kid\":\"…\", \"use\":\"sig\", \"alg\":\"ES256\", \"x\":\"…\", \"y\":\"…\" } ] }"
        },
        {
          "type": "text",
          "content": "The verifiers are every API service (through api-core's requireAuth), the pipeline-manager CLI, image-registry's /token mint path, and the pipeline-events Lambda. Each caches the key set, refreshes it every 10 minutes, refetches once when it sees an unknown kid (which is how a rotated-in key starts working without a restart), briefly negative-caches a failed fetch, and fails closed: a token it cannot verify is answered 503 (retry), never allowed through."
        },
        {
          "type": "text",
          "content": "Why it matters: before this, all ten services shared one HMAC secret, so any one of them could mint a platform-admin token. Now a service compromise cannot produce a user identity at all."
        },
        {
          "type": "table",
          "headers": [
            "Token",
            "Signed by",
            "Algorithm",
            "Verified by"
          ],
          "rows": [
            [
              "access, refresh, step-up, exchanged access key",
              "platform only",
              "ES256 + kid",
              "everyone, via the JWKS"
            ],
            [
              "internal service token (service:<name>)",
              "the CALLING service, its own key",
              "ES256 + kid",
              "everyone, against the mounted public key bundle"
            ],
            [
              "image-registry's own Docker-registry tokens",
              "image-registry",
              "RS256 + its own keypair",
              "the Docker registry"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The two chains are kept apart by construction, in both directions: a token verified with a SERVICE key that claims principalType: user is refused everywhere, and a token verified against platform's JWKS that claims principalType: service is refused too. Both chains are ES256 now, so a bearer token is routed by who owns its kid — and a kid is the RFC 7638 thumbprint of the key itself, so ownership is a fact about the key rather than a claim the token makes about itself. An HS256 token is accepted by neither chain."
        },
        {
          "type": "text",
          "content": "See Internal service tokens for the service half."
        },
        {
          "type": "text",
          "content": "The private key lives either in a file platform reads at boot (TOKEN_SIGNING_MODE=local — a Kubernetes Secret on the cluster targets) or inside AWS KMS (TOKEN_SIGNING_MODE=kms, an asymmetric ECC_NIST_P256 sign-only key), chosen by config. Platform refuses to start if it cannot load a signing key: it is the only minter in the fleet, so there is no degraded mode worth serving."
        },
        {
          "type": "text",
          "content": "Rotation is by kid — publish the incoming key next to the retiring one, switch signing, then stop publishing the old one. No verifier restarts, and no session breaks. Operator steps: Secret Rotation."
        },
        {
          "type": "text",
          "content": "Install — signing keys must exist before anything starts"
        },
        {
          "type": "text",
          "content": "Signing keys are install prerequisites, not a migration step. Platform is the only minter of user tokens and refuses to start without a key, and every service signs its own internal tokens, so a target that skipped these steps comes up dead rather than degraded. There is no shared-secret fallback to land on: no JWT_SECRET, no REFRESH_TOKEN_SECRET, and no target declares either."
        },
        {
          "type": "list",
          "items": [
            "Generate the user-token signing key before starting platform —"
          ]
        },
        {
          "type": "text",
          "content": "deploy/bin/token-signing-keys.sh <target>/certs on the local targets, or create the KMS key and set TOKEN_SIGNING_MODE=kms + TOKEN_SIGNING_KMS_KEY_ID. Platform refuses to start without one."
        },
        {
          "type": "list",
          "items": [
            "Generate the per-service internal keys with"
          ]
        },
        {
          "type": "text",
          "content": "deploy/bin/service-signing-keys.sh BEFORE starting any service, and start every service together — each one verifies its peers by kid against the shared bundle (see Internal service tokens)."
        },
        {
          "type": "list",
          "items": [
            "The gateway receives no signing secret: each target's nginx/jwt.js decodes"
          ]
        },
        {
          "type": "text",
          "content": "claims for the access log and the x-org-id / x-user-id hints and verifies nothing (ES256 verification needs an async JWKS fetch, which a synchronous njs js_set handler cannot make). Nothing is lost that was enforcing: the gateway never rejected a request, and each service re-derives the request's tenant identity from the token it verified itself. The anti-spoof property also survives — nginx still OVERWRITES those headers on every proxied request, so a client cannot inject an org id of its choosing."
        },
        {
          "type": "list",
          "items": [
            "Check GET /.well-known/jwks.json through the gateway before announcing the"
          ]
        },
        {
          "type": "text",
          "content": "deploy done: every verifier depends on it, and a target whose nginx does not proxy that path cannot verify any token."
        }
      ]
    },
    {
      "id": "internal-service-tokens-one-key-per-service",
      "title": "Internal service tokens (one key per service)",
      "blocks": [
        {
          "type": "text",
          "content": "Inter-service calls (billing → message, platform → compliance, every service → quota's usage counters) carry their own token, minted by signServiceToken with principalType: 'service' and sub: service:<name>, and living 5 minutes."
        },
        {
          "type": "text",
          "content": "Each service signs those with its own ES256 key. Before this, all ten shared one JWT_SECRET, which meant any service could mint a token naming any other — \"billing said so\" was unfalsifiable, and one compromised workload spoke for the whole fleet. Now:"
        },
        {
          "type": "list",
          "items": [
            "the token's kid is the thumbprint of the signing key, and the verifier looks"
          ]
        },
        {
          "type": "text",
          "content": "the key up by that kid, which also tells it which service owns it;"
        },
        {
          "type": "list",
          "items": [
            "the token's sub must name that same service, so a token signed by compliance"
          ]
        },
        {
          "type": "text",
          "content": "claiming to be billing is a forgery, not a valid token with a confusing subject;"
        },
        {
          "type": "list",
          "items": [
            "a service that captures another's token can still replay it inside its 5-minute"
          ]
        },
        {
          "type": "text",
          "content": "life — what it cannot do is mint one."
        },
        {
          "type": "text",
          "content": "Public keys are distributed by config, not by per-service JWKS endpoints. The deploy generates a keypair per service, mounts each private key into only that service, and mounts one public bundle everywhere:"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Holds"
          ],
          "rows": [
            [
              "SERVICE_SIGNING_KEY_FILE",
              "this service's EC P-256 private key (PKCS#8 PEM). Per service."
            ],
            [
              "SERVICE_KEY_BUNDLE_FILE",
              "{\"services\": {\"<name>\": {\"keys\": [<jwk>…]}}} — every service's public keys. Identical everywhere; public."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Three properties decided that over an HTTP key set per service:"
        },
        {
          "type": "list",
          "items": [
            "verifyServicePrincipal stays synchronous. The global rate limiter's"
          ]
        },
        {
          "type": "text",
          "content": "skip and the /warmup guard verify a service token before requireAuth runs, in synchronous Express callbacks; an HTTP fetch would make them async."
        },
        {
          "type": "list",
          "items": [
            "No availability coupling. Fetching billing's keys from billing would mean"
          ]
        },
        {
          "type": "text",
          "content": "billing being down stops platform accepting billing's in-flight calls — turning one outage into several."
        },
        {
          "type": "list",
          "items": [
            "No N×N address config, including under docker compose, which has no mesh"
          ]
        },
        {
          "type": "text",
          "content": "and no service discovery beyond DNS."
        },
        {
          "type": "text",
          "content": "deploy/bin/service-signing-keys.sh generates and rotates both halves; a service refuses to start without them. Rotation is by kid, two-phase, and needs no coordinated restart: Secret Rotation."
        },
        {
          "type": "text",
          "content": "Internal routes"
        },
        {
          "type": "text",
          "content": "A handful of routes exist ONLY for service-to-service calls — /internal/*, the quota usage counters, the entity-event and audit ingests, and the billing→ compliance / billing→reporting entitlement legs. They go through one shared gate, requireInternalService({ callers: [...] }), which:"
        },
        {
          "type": "list",
          "items": [
            "refuses every user token outright — not a member's, not a superadmin's, not"
          ]
        },
        {
          "type": "text",
          "content": "an access key's. \"A sufficiently privileged human\" is not an acceptable caller for a peer-service API; that equivalence is how a browser-reachable path becomes a tenant-boundary bug. (This replaced several || isSystemAdmin(req) escape hatches that had grown around the individual routes.)"
        },
        {
          "type": "list",
          "items": [
            "admits only the named callers, and since the name is bound to the signing"
          ]
        },
        {
          "type": "text",
          "content": "key this is an identity check rather than a claim check."
        },
        {
          "type": "text",
          "content": "Refusals increment internal_route_refused_total{service,route,reason,caller} (reason is unauthenticated, user_token or wrong_caller) and are written to the audit trail as authz.denied."
        },
        {
          "type": "text",
          "content": "Each service's route-coverage test declares its internal routes and their callers and checks the declaration against the code in both directions, and any route whose path contains /internal/ must carry the gate — with no exception list."
        },
        {
          "type": "text",
          "content": "On minikube, EC2 and EKS an Istio AuthorizationPolicy per internal route names the same calling service accounts, as a second, independent refusal (deploy/*/k8s/istio-internal-routes.yaml). It is defence in depth, never the enforcement: docker compose runs no mesh at all, so the token check has to hold on its own there — which packages/api-core/test/internal-route-mesh-less.test.ts proves by running the mesh-less configuration against a real HTTP server and real keys."
        }
      ]
    },
    {
      "id": "token-claims-what-a-request-proves",
      "title": "Token claims (what a request proves)",
      "blocks": [
        {
          "type": "text",
          "content": "Every access token carries an explicit identity, so an auth decision never has to infer one from the shape of a token:"
        },
        {
          "type": "table",
          "headers": [
            "Claim",
            "Values",
            "Meaning"
          ],
          "rows": [
            [
              "principalType",
              "user, service_account, service",
              "Who the token speaks for. service is an internal Pipeline Builder service (signServiceToken); service_account is an org service account — a non-human principal owned by one org."
            ],
            [
              "token_use",
              "access, api_key",
              "access is a session token (interactive, machine session, or service); api_key is the short-lived token an access key was exchanged for — its jti is the key's id."
            ],
            [
              "amr",
              "pwd, oauth, sso, webauthn, stepup, mfa",
              "How the person authenticated. webauthn is a passkey assertion with user verification. mfa says a second factor was presented as well — an authenticator-app code or one of its recovery codes — so it appears ALONGSIDE the method that identified the user (['pwd', 'mfa']), never on its own."
            ],
            [
              "aal",
              "1, 2",
              "Assurance level, decided once in signInAuth when the session is opened and never raised afterwards. 2 for a passkey assertion (user verification required), a sign-in that also presented an authenticator-app code or a recovery code (amr: ['pwd', 'mfa']), or SSO through an IdP the org has marked as enforcing MFA (idpEnforcesMfa). 1 for everything else — a password alone, a social sign-in, SSO through an unmarked IdP, a bootstrap-admin enrolment session, and every machine credential (an exchanged access key carries amr: [] with aal: 1, so it can never satisfy a requirement). Routes demand a minimum with minAssurance; see Assurance levels and required MFA."
            ],
            [
              "auth_time",
              "epoch seconds",
              "When the sign-in behind the session happened."
            ],
            [
              "scope",
              "e.g. reporting:ingest",
              "A narrow machine capability; a scoped token is minted least-privilege (member role, no features, no permissions)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "amr, aal and auth_time are stored on the refresh-session slot, so a refresh, a machine-credential renewal and an org switch all reproduce them unchanged — none of those can raise the assurance level or make a sign-in look fresher than it was. An access key stores the creating session's values on its record, and an impersonation session inherits the operator's, so neither can raise assurance."
        },
        {
          "type": "text",
          "content": "The tenant a request acts in"
        },
        {
          "type": "text",
          "content": "organizationId on the verified token is the ONLY tenant authority for a person or an org service account. The x-org-id header is client-settable, so getIdentity (api-core) honors it in exactly two cases: an internal service principal, whose token names the signing service rather than the tenant it is acting for (the S2S hop convention — the org cascade, the quota client, the reporting ingest), and a request with no verified principal yet, which requireAuth immediately recomputes from the token. For a user or service_account principal the header is ignored outright — platform can mint a user token with no organizationId (a person between orgs, mid-invite, mid-onboarding), and that value flows straight into the Postgres RLS tenant GUC, so a header fallback there would let such a token name any tenant it liked. With no org on the token the request simply has no tenant and a route needing one refuses it. The sysadmin x-org-id override is unaffected: requireAuth writes it onto req.user.organizationId after verifying the isSuperAdmin claim."
        },
        {
          "type": "text",
          "content": "Whatever the source, the org id is canonicalized once (trim + lowercase, normalizeOrgId) so the RLS GUC, the app-layer WHERE clauses and every same-org comparison — platform's controller-helper, quota's authorizeOrg — agree on the spelling."
        },
        {
          "type": "text",
          "content": "Services reject a token that lacks these claims (an unknown principalType, a user principal with no assurance claims, a service principal whose subject doesn't name a service). There is no legacy shape: every token minted before this release stops working at release — sessions re-authenticate, and stored machine credentials must be re-issued (see below). Personal access tokens are gone entirely; they are replaced by access keys."
        }
      ]
    },
    {
      "id": "access-keys-opaque-verified-by-exchange",
      "title": "Access keys (opaque, verified by exchange)",
      "blocks": [
        {
          "type": "text",
          "content": "A CLI, CI job or integration authenticates with an access key, not a JWT:"
        },
        {
          "type": "code",
          "content": "pb_pat_Xy3kQ0…            a person's key (43 base64url chars of CSPRNG output)\npb_sa_Ab1cD2…             an org SERVICE ACCOUNT's key (see below)"
        },
        {
          "type": "text",
          "content": "The key is opaque: it carries no claims and no signature, so nothing can be read out of it and nothing can verify it locally. Platform stores only sha256(key) plus the prefix and last four characters, which is all the UI can ever show (pb_pat_…a1b2). The key itself is displayed exactly once, in the create response — there is no way to recover it afterwards."
        },
        {
          "type": "text",
          "content": "How a request with a key is authenticated"
        },
        {
          "type": "code",
          "content": "caller ──Authorization: Bearer pb_pat_…──▶ any service\n                                            │\n                       POST /auth/token/exchange  (once per 5 minutes, cached)\n                                            ▼\n                                        platform ──▶ 5-minute JWT (token_use: api_key)\n                                            │\n                          every service then verifies that JWT as usual"
        },
        {
          "type": "text",
          "content": "Only platform, billing and quota have MongoDB, so the other services cannot look up a key hash — and asking platform on every request would put it on the hot path of the whole fleet. Instead api-core exchanges the key once and caches the returned JWT in-process until it expires, re-exchanging early (at ~75 % of its life, jittered ±10 %) so no request ever blocks on the exchange and a fleet of pods doesn't stampede platform together. Concurrent requests for one key share a single round-trip, and a key platform refused is remembered for 30 s."
        },
        {
          "type": "text",
          "content": "Platform itself skips the round trip: it owns the collection, so a key presented straight to it is resolved in place — through the same service, producing the same claims."
        },
        {
          "type": "text",
          "content": "What this buys, and what it costs:"
        },
        {
          "type": "list",
          "items": [
            "Revocation works everywhere. A revoked key can no longer be exchanged, so"
          ]
        },
        {
          "type": "text",
          "content": "it stops working on every service within one token lifetime (5 minutes). The old JWT PAT was only checked at platform and kept working elsewhere for up to 365 days."
        },
        {
          "type": "list",
          "items": [
            "Claims are never stale. Role, permissions, tier, features and isSuperAdmin"
          ]
        },
        {
          "type": "text",
          "content": "are re-derived from the user and their membership on every exchange, so a demotion reaches the key in the same 5 minutes. A JWT PAT baked them at mint."
        },
        {
          "type": "list",
          "items": [
            "Accurate last-used. The exchange is what stamps lastUsedAt, so the keys"
          ]
        },
        {
          "type": "text",
          "content": "page is right no matter which service the key was actually used against."
        },
        {
          "type": "list",
          "items": [
            "Platform down is a 503, not a pass. A service that cannot reach platform"
          ]
        },
        {
          "type": "text",
          "content": "answers 503 SERVICE_UNAVAILABLE and increments api_key_exchange_failures_total{reason=\"unavailable\"}. An unverifiable credential is not an identity, so this path deliberately does not fail open."
        },
        {
          "type": "text",
          "content": "The exchange endpoint"
        },
        {
          "type": "text",
          "content": "POST /auth/token/exchange with { \"key\": \"pb_pat_…\" } returns { accessToken, expiresIn, keyId }. It is pre-auth by construction (the key is the credential, exactly as the password is on /auth/login) and is rate-limited twice: per presented key (60/min, keyed on the key's hash — never the key) and per client IP (300/min, skipped for a verified internal service principal, since one service pod exchanges on behalf of many keys). Both outcomes are audited — user.key.exchange names the key and its owner, user.key.exchange.failed records why it was refused. The response never differentiates: unknown, revoked, expired and \"the org went away\" all answer the same 401, so the endpoint can't be used to tell a real key id from a guess."
        },
        {
          "type": "text",
          "content": "Managing keys"
        },
        {
          "type": "text",
          "content": "Dashboard → Security → Access keys lists every key with its scope, expiry, last use and where it was created, and flags the two things an access review actually asks about: a key that has never been used and one expiring within 14 days. Creating a key is step-up gated (minting a durable bearer credential is at least as sensitive as changing a password, and step-up also stops key-chaining: a key can't produce the step-up token a new key needs). Revoking is immediate and irreversible."
        },
        {
          "type": "text",
          "content": "The CLI mints one with pipeline-manager auth pat --name <name> — a browser sign-in whose approval supplies the step-up, so no password is typed; the printed key is what PLATFORM_TOKEN expects. POST /user/tokens/revoke-all (\"Sign out everywhere\") revokes every key the user holds, as does deleting the account."
        },
        {
          "type": "note",
          "content": "A key is the only shape. There is no JWT personal access token to fall back to — a key is a secret the server never had, so it can only be issued. Each holder creates their own from the keys page (or pipeline-manager auth pat) and stores it wherever their automation reads it. See Access Keys and Machine Credentials for the operator procedure, including the AWS Secrets Manager entries."
        },
        {
          "type": "text",
          "content": "Scoping a personal key to selected permissions"
        },
        {
          "type": "text",
          "content": "A personal access key (and a machine token from POST /user/generate-token) is one of three things:"
        },
        {
          "type": "table",
          "headers": [
            "Kind",
            "What its token carries",
            "When to use it"
          ],
          "rows": [
            [
              "Selected permissions (the default in the UI, seeded with the read-only permissions you hold)",
              "permissions = the key's catalog subset ∩ what you hold at that moment, plus permissionsRestricted: true",
              "Automation acting as you but needing only part of what you can do"
            ],
            [
              "Full access",
              "Everything your Roles grant in the key's org, re-derived at every exchange",
              "Your own CLI"
            ],
            [
              "Capability scope (reporting:ingest, registry:push, scim)",
              "No permissions at all — one capability",
              "A machine surface that does exactly one thing"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The subset is sent as permissions: string[] on POST /user/keys or POST /user/generate-token. Every id must be in the permission catalog, at least one must be chosen, it can't be combined with scope (400), and it must be ⊆ the permissions you hold now — re-resolved from your Roles and also bounded by the calling token's own claim (403 PERMISSION_SUBSET_EXCEEDS, naming what you don't hold). The subset is stored on the key (or the machine-session slot), shown in the keys list, and recorded in user.key.create / user.token.create (details.permissions; absent means full access)."
        },
        {
          "type": "text",
          "content": "Because the token's permissions are the intersection re-computed at every exchange (every renewal, for a machine token), losing a Role shrinks the key within one token lifetime, and nothing — a new Role, promotion to admin, superadmin — ever grows it past its subset. A restricted token is also forced to role: member with no isSuperAdmin, since an admin role label or the implicit-all flag would bypass the subset. Anything minted from a restricted token inherits its restriction: a new key or machine token asking for \"full access\" gets the caller's own current permissions, a switch-org without a session slot and sign-out-everywhere's replacement session keep it, and a machine session's subset is fixed for its life (a renewal naming a different set is refused as TOKEN_SCOPE_ESCALATION)."
        },
        {
          "type": "text",
          "content": "PAT scoping vs. service-account Roles. A scoped personal key still is you: it is attributed to you in the audit trail, dies with your account, and shrinks when your Roles do. A service account is an org-owned identity whose authority is the org Roles assigned to it — the right choice when the automation should outlive (or not depend on) any one person, needs an IP allowlist, or is managed by service_accounts:manage holders rather than by you. Service-account keys take no permission subset: to narrow one, give the account a narrower Role."
        }
      ]
    },
    {
      "id": "service-accounts",
      "title": "Service accounts",
      "blocks": [
        {
          "type": "text",
          "content": "A service account is a non-human principal owned by ONE organization. It has no password, no email sign-in and no sessions: it authenticates only with pb_sa_… keys, traded at the very same POST /auth/token/exchange endpoint a personal key uses, for a 5-minute token carrying principalType: 'service_account' and token_use: 'api_key'."
        },
        {
          "type": "text",
          "content": "Use one wherever automation currently runs as a person — CI, deploy hooks, ingest, the setup scripts. The point is that it does not belong to anyone:"
        },
        {
          "type": "table",
          "headers": [
            "Rule",
            "What it means in practice"
          ],
          "rows": [
            [
              "Org-owned, never orphaned",
              "The creator is recorded for attribution only. When they leave, the account keeps working; only the org purge deletes it (with every key)."
            ],
            [
              "Roles, through the same machinery",
              "It holds the org's Roles via role_assignments, and the assignment ceiling is identical: you can never create an account more powerful than yourself. Only a platform superadmin may grant a superadmin-granting Role."
            ],
            [
              "Never impersonated",
              "Impersonation acts on user accounts; a service account has no user record to assume."
            ],
            [
              "SSO enforcement does not apply",
              "SSO governs how PEOPLE sign in. A service account never signs in, so an org's SSO requirement neither blocks nor covers it — revoke its keys to cut it off."
            ],
            [
              "Never satisfies assurance",
              "Its token carries amr: [] and aal: 1, and requireStepUp refuses the principal outright — so a key can never be used to mint another key, delete an org, or pass any human-presence gate."
            ],
            [
              "No seat",
              "Seats count distinct active humans. A service account creates no membership row, so it consumes none — adding accounts never costs a seat."
            ],
            [
              "Its own quota",
              "Each account has a per-period token-exchange budget (QUOTA_RESET_DAYS, unlimited by default). Every exchange consumes one unit, metered atomically, so runaway automation is bounded on the account's own budget instead of draining the org's API quota. Entity quotas (pipelines, plugins) still belong to the org that owns the created entity."
            ],
            [
              "Keys expire, and are capped",
              "At most 5 active keys per account, each at most 365 days, with an optional per-key IP allowlist."
            ],
            [
              "Rate-limited per account",
              "Platform buckets an account's traffic under its own key (sa:<id>, or the presented key's hash pre-auth), and rateLimitByOrg does the same, so one noisy account cannot exhaust the window its org's people share."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Creation and key management live at Dashboard → Settings → Service Accounts. Every route — the listing included — requires service_accounts:manage, and every write is step-up gated exactly like creating a personal access key (revoking a key is not, so a compromised credential can be killed immediately). The keys also appear on Dashboard → API Tokens, in the same list as personal keys, labelled with their owning account."
        },
        {
          "type": "text",
          "content": "The IP allowlist, precisely"
        },
        {
          "type": "text",
          "content": "A key's allowlist is enforced at the exchange, against the address platform sees for that request:"
        },
        {
          "type": "list",
          "items": [
            "a key presented straight to platform (the CLI, curl, the deploy scripts)"
          ]
        },
        {
          "type": "text",
          "content": "is checked against the caller's own address — req.ip, i.e. what the ingress reports, not a client-supplied header;"
        },
        {
          "type": "list",
          "items": [
            "a key presented to another service is exchanged by that service, so the"
          ]
        },
        {
          "type": "text",
          "content": "address platform sees is the calling pod's. Treat the allowlist as a perimeter control for credentials used against platform, not as a per-service one."
        },
        {
          "type": "text",
          "content": "An allowlist that is set but cannot be evaluated (no address, an unparseable one) denies — the control exists to bind a key to known addresses, so \"couldn't tell\" must not pass."
        },
        {
          "type": "text",
          "content": "Setup automation uses one"
        },
        {
          "type": "text",
          "content": "deploy/bin/init-platform.sh registers the bootstrap admin, signs in once, and then creates a system-org service account named setup with a single 24-hour key. The plugin, template and compliance loads run with that key instead of re-running login with the admin password between steps. Consequences worth knowing:"
        },
        {
          "type": "list",
          "items": [
            "the admin's password is used exactly twice (register, sign-in + the two step-up"
          ]
        },
        {
          "type": "text",
          "content": "confirmations) and never leaves the script;"
        },
        {
          "type": "list",
          "items": [
            "both mints happen while the bootstrap exception"
          ]
        },
        {
          "type": "text",
          "content": "is still open, under its bootstrap-setup assurance exemption — which is why init creates the account immediately after signing in, and why enrolling a factor first (closing the exception) is the operator's next step, not the script's;"
        },
        {
          "type": "list",
          "items": [
            "the key expires by itself in 24 hours, so a half-finished install leaves no"
          ]
        },
        {
          "type": "text",
          "content": "durable credential behind;"
        },
        {
          "type": "list",
          "items": [
            "the load steps are audited as the setup account, not as a person;",
            "re-running init is idempotent: the existing setup account is reused and its"
          ]
        },
        {
          "type": "text",
          "content": "previous keys are revoked before the new one is issued, so the 5-key cap can never fail a re-run. Override the lifetime with SETUP_KEY_TTL_SECONDS;"
        },
        {
          "type": "list",
          "items": [
            "re-running it after the admin enrols needs a second factor, because the"
          ]
        },
        {
          "type": "text",
          "content": "exemption closed with the exception. An account with an authenticator app is offered a challenge at sign-in, so init finishes it: set PLATFORM_TOTP_CODE to a current code (or a recovery code), or answer the prompt when running interactively. A passkey-only admin has no code to give a script — enrol an authenticator app for that account, or re-run init from a host where a human can drive the dashboard instead."
        },
        {
          "type": "text",
          "content": "Scoped keys — one capability, no Roles"
        },
        {
          "type": "text",
          "content": "A key may carry a capability scope instead of the account's Roles. The exchanged token then has scope set, permissions: [], role: 'member' and no admin flags at all, whatever the account itself holds. That is the shape every automation which does exactly one thing should hold:"
        },
        {
          "type": "table",
          "headers": [
            "Scope",
            "What it can do",
            "Who holds one"
          ],
          "rows": [
            [
              "reporting:ingest",
              "POST /reports/events, /reports/ingest-health, /reports/incidents",
              "the AWS event-ingestion Lambda; the incident webhook"
            ],
            [
              "registry:push",
              "docker pull/push inside the owning org's org-{id}/* namespace, through image-registry's /token",
              "CodeBuild's registry credentials; any CI that pushes images"
            ],
            [
              "scim",
              "the whole /scim/v2 surface — provision, update and deactivate members of the owning org, and move them between directory groups",
              "an identity provider's SCIM client (see SCIM 2.0 provisioning)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The scope is checked by the consuming route (hasScope, a single-value equality check), so a token carrying one scope can never satisfy another, and an unscoped key — even one on an account holding the org admin Role — satisfies none of them. registry:push grants the raw-image write that plugins:write grants a person, and nothing else: the namespace rules in image-registry key off organizationId and isSuperAdmin, neither of which a scoped mint can raise, so a leaked push credential reaches its own org's namespace and stops there."
        },
        {
          "type": "text",
          "content": "Set it when the key is issued:"
        },
        {
          "type": "code",
          "content": "POST /organization/{orgId}/service-accounts/{accountId}/keys\n{ \"name\": \"ci-push\", \"expiresIn\": 2592000, \"scope\": \"registry:push\" }",
          "language": "http"
        },
        {
          "type": "text",
          "content": "The valid values are api-core's closed TOKEN_SCOPES catalog — one list, shared by every mint path, so an unknown scope is a 400, never a silently unenforced credential."
        },
        {
          "type": "text",
          "content": "Self-rotation — how an unattended machine replaces its own key"
        },
        {
          "type": "text",
          "content": "Every key write on the org routes is step-up gated, and a service account can never step up (amr: []). A machine with no password therefore cannot rotate its own credential through those routes at all. Two pre-auth endpoints exist for exactly that, where the key itself is the authorization:"
        },
        {
          "type": "table",
          "headers": [
            "Route",
            "Body",
            "Effect"
          ],
          "rows": [
            [
              "POST /auth/key/rotate",
              "{ key, name?, expiresIn? }",
              "Mints a sibling key on the same account, inheriting the presented key's scope, IP allowlist and (by default) its original lifetime. The presented key stays live."
            ],
            [
              "POST /auth/key/revoke",
              "{ key, keyId }",
              "Retires a sibling key, authenticated with the one that replaced it."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Both run the same gates as an exchange (account enabled, org live, address inside the allowlist, budget available), share its two rate limiters, and are audited as org.service-account.key.rotate / .revoke attributed to the account."
        },
        {
          "type": "text",
          "content": "Two rules make the whole thing safe, and they are the reason the ordering works:"
        },
        {
          "type": "list",
          "items": [
            "A key may never revoke itself here (400 SELF_REVOKE_REFUSED). The rotator"
          ]
        },
        {
          "type": "text",
          "content": "can therefore not destroy the credential it is holding."
        },
        {
          "type": "list",
          "items": [
            "Only a pb_sa_ key may rotate. A person's key is managed in the UI behind"
          ]
        },
        {
          "type": "text",
          "content": "step-up; letting one rotate itself would be a step-up bypass."
        },
        {
          "type": "text",
          "content": "The caller's order is rotate → store → revoke, and every failure leaves a working credential:"
        },
        {
          "type": "table",
          "headers": [
            "Fails at",
            "What survives"
          ],
          "rows": [
            [
              "rotate",
              "The secret is untouched; the current key is still live."
            ],
            [
              "store",
              "The secret still names the current key, which is still live. The new key is an orphan that expires on its own."
            ],
            [
              "revoke",
              "Both keys work. The credential is healthy; the stale key expires on its own."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Revoke-then-create would invert all three. If an earlier rotation never revoked its predecessor, the account drifts towards its 5-key cap — so rotate retires the oldest active sibling (never the presented key) when it is at the cap, and reports what it pruned in prunedKeyIds."
        },
        {
          "type": "text",
          "content": "Stored machine credentials (AWS)"
        },
        {
          "type": "text",
          "content": "pipeline-manager infra store-token provisions the org's machine identity and parks a key in AWS Secrets Manager. It creates (or reuses) the service account, issues one key, writes the secret, and only then retires the key the previous run stored:"
        },
        {
          "type": "table",
          "headers": [
            "Secret",
            "Account",
            "Roles",
            "Key scope",
            "Read by"
          ],
          "rows": [
            [
              "pipeline-builder/{orgId}/platform",
              "platform-automation",
              "org admin",
              "none",
              "CDK synth/deploy callbacks (--store-tokens), the plugin-lookup Lambda"
            ],
            [
              "pipeline-builder/{orgId}/registry-push",
              "registry-push",
              "none",
              "registry:push",
              "CodeBuild's secretsManagerCredentials (Basic auth to image-registry)"
            ],
            [
              "pipeline-builder/{orgId}/reporting-ingest",
              "reporting-ingest",
              "none",
              "reporting:ingest",
              "the event-ingestion Lambda"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The secret's schema is unchanged in shape — { username, password, platformUrl, … } — and password is still the canonical field. What changed is its VALUE: a pb_sa_… key instead of a JWT. Nothing downstream verifies it, because there is nothing in an opaque key to verify: image-registry and every service exchange it (api-core's cached exchange client), and the events Lambda exchanges it itself. The secret additionally records keyId, serviceAccountId and scope, which is what the rotation Lambda needs to retire the key it replaces."
        },
        {
          "type": "text",
          "content": "Because creating an account and issuing a key are step-up gated, store-token needs the operator's password — PLATFORM_PASSWORD (preferred) or --password. --schedule installs the daily rotation stack described above."
        }
      ]
    },
    {
      "id": "cli-sign-in-by-device-authorization-rfc-8628",
      "title": "CLI sign-in by device authorization (RFC 8628)",
      "blocks": [
        {
          "type": "text",
          "content": "pipeline-manager auth login has no password flag, and there is no way to hand the CLI a refresh token. It signs in with the OAuth 2.0 device authorization grant instead:"
        },
        {
          "type": "list",
          "items": [
            "POST /auth/device/code — the CLI asks for a code. It gets back a"
          ]
        },
        {
          "type": "text",
          "content": "device_code (256 bits of randomness, the credential it will redeem), a short user_code (BCDF-GHJK), verification_uri, verification_uri_complete, expires_in (10 minutes) and interval (5 seconds)."
        },
        {
          "type": "list",
          "items": [
            "The CLI prints the code and the URL, and opens a browser when it can (never"
          ]
        },
        {
          "type": "text",
          "content": "under CI, over SSH, or with --no-browser)."
        },
        {
          "type": "list",
          "items": [
            "The person signs in in the browser if they are not already, sees which"
          ]
        },
        {
          "type": "text",
          "content": "device is asking (its client summary and IP, its code, when it expires), and confirms. Approving is step-up gated, so it is factor-agnostic: a password, a provider re-auth for a social/SSO account, and later a passkey or TOTP all satisfy it. Whatever the org enforces for the browser — SSO, MFA — already applies, because this is a browser session."
        },
        {
          "type": "list",
          "items": [
            "POST /auth/device/token — the CLI polls. Until the person decides it gets"
          ]
        },
        {
          "type": "text",
          "content": "the RFC's authorization_pending; polling faster than the interval gets slow_down (and the interval widens by 5 seconds, permanently for that flow); a refusal gets access_denied; a lapsed, over-polled or already-redeemed code gets expired_token."
        },
        {
          "type": "list",
          "items": [
            "On approval the poll returns the session, and the flow is consumed — the"
          ]
        },
        {
          "type": "text",
          "content": "device code cannot be redeemed twice."
        },
        {
          "type": "text",
          "content": "Why the CLI ends up with a normal session. The approved session is an ordinary interactive refresh session, opened through the same issueTokens path as a browser login, carrying the requesting device's client summary and IP. It therefore appears under Settings → Sessions and devices as \"pipeline-manager CLI on macOS\" and is signed out from there like any other device. It inherits the approving session's amr, aal and auth_time verbatim — approving on a second device can never raise assurance or reset the sign-in time."
        },
        {
          "type": "text",
          "content": "State and abuse resistance. The two entries live in the shared Redis pending-state store, so the pod that mints a code, the pod that serves the approval page and the pod that answers the poll need not be the same one. The record is keyed by the hash of the device code, never the code. The user_code is drawn from a 20-character alphabet with no vowels and no look-alikes (BCDFGHJKLMNPQRSTVWXZ) — 20⁸ ≈ 2.6 × 10¹⁰ combinations, alive for 10 minutes. The poll is limited per device code (30/min, keyed on its hash) and per IP (300/min), and each code has a hard ceiling of 200 polls; the browser endpoints are limited per signed-in user (15/min), which is what bounds guessing the short code. /auth/device/* is mounted ahead of /auth so it never shares the strict pre-auth bucket, and the poll is exempt from the general limiter — a conforming client legitimately sends ~120 requests per sign-in."
        },
        {
          "type": "text",
          "content": "Audit. device.authorize.start (pre-auth, actor anonymous, with the requesting device in details), device.authorize.approve, device.authorize.deny and device.authorize.expire. All four carry the flow's correlation handle as targetId — a truncated hash of the device code, so the trail joins up without recording either live code. The metric is platform_device_authorizations_total{result}."
        },
        {
          "type": "text",
          "content": "auth pat uses the same flow. Creating an access key is step-up gated server-side, which used to force the CLI to hold a password and POST it twice (sign-in, then step-up). Now the CLI sets step_up: true on /auth/device/code, the browser approval supplies the step-up, and the approved poll returns a short-lived step_up_token alongside the session — spent immediately on POST /user/keys. No password is typed into a terminal at any point."
        },
        {
          "type": "text",
          "content": "Where the session is kept. ~/.pipeline-manager/credentials.json, owner-only (0600 inside the 0700 directory), keyed by platform base URL so one workstation can hold sessions for several platforms. PLATFORM_TOKEN always takes precedence, which is what CI sets to an access key."
        },
        {
          "type": "note",
          "content": "At release — no backward compatibility. auth login -u/-p and auth login --refresh <token> are gone, not deprecated. Scripts that used either must move to an access key (auth pat, exported as PLATFORM_TOKEN) — which is what they should have used anyway, since a session token expires in minutes. init-platform.sh and infra provision --admin-password still register and log in the bootstrap admin with a password over curl: that is a genuinely non-interactive first-boot step with no browser to approve anything in, and it is the only password path left."
        }
      ]
    },
    {
      "id": "where-the-refresh-token-lives",
      "title": "Where the refresh token lives",
      "blocks": [
        {
          "type": "text",
          "content": "The refresh token is a 30-day credential. It is delivered over one of two transports, chosen by a single explicit signal — the X-Pb-Client request header:"
        },
        {
          "type": "table",
          "headers": [
            "Caller",
            "Sends",
            "Receives the refresh token as",
            "Presents it as"
          ],
          "rows": [
            [
              "Browser app",
              "X-Pb-Client: web",
              "Set-Cookie: pb_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh — never in the response body",
              "the cookie, attached automatically"
            ],
            [
              "CLI / CI / scripts",
              "X-Pb-Client: cli (any value but web)",
              "refreshToken in the JSON body",
              "{\"refreshToken\": \"…\"} in the request body"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The CLI receives its pair from the device-authorization poll above and keeps it in its own credential store; it never accepts one typed on a command line."
        },
        {
          "type": "text",
          "content": "The browser's access token is held in memory only — there is no localStorage copy of either token. A page reload therefore starts with no access token and silently trades the cookie for a new one (ApiCore.restoreSession()); a non-secret pb.session marker in localStorage records only that a session exists, so an anonymous visitor isn't made to probe the refresh endpoint. An XSS that runs in the page can no longer walk off with a 30-day credential; the worst it can reach is a 15-minute access token."
        },
        {
          "type": "text",
          "content": "Because the cookie is ambient authority, POST /auth/refresh and POST /auth/logout refuse any request without the X-Pb-Client header (403 CLIENT_TYPE_REQUIRED). A cross-site form, image or navigation cannot set a custom header, and a cross-origin fetch that tries triggers a preflight CORS refuses — so a foreign page cannot spend the cookie. The requirement is unconditional, including for CLI callers, so that it cannot be stripped."
        },
        {
          "type": "text",
          "content": "Both transports are read by POST /auth/refresh; when a request carries both a cookie and a body token, the cookie wins — a browser must not be talked into refreshing a token some injected script supplied. Every endpoint that issues a session (login, the OAuth and SSO callbacks, switch-org, tokens/revoke-all) uses the same split; logout, /auth/refresh's rejection and account deletion all clear the cookie, because only the server can."
        },
        {
          "type": "text",
          "content": "Cross-tab: tabs can no longer read the refresh token, so they coordinate over a BroadcastChannel (pipeline-builder:auth) plus the existing Web Lock. The tab that wins the lock refreshes and broadcasts the new access token; the others adopt it instead of rotating the shared cookie again. A sign-out in one tab is broadcast too. The Web Lock is load-bearing: it guarantees a sibling's Set-Cookie has landed before the next tab presents the cookie, so two tabs refreshing together can never both send the pre-rotation token (which the server would read as reuse and answer by revoking the slot)."
        },
        {
          "type": "text",
          "content": "At release: sessions opened before this change simply stop refreshing — their refresh token was in localStorage, which is no longer read, and no cookie exists for them. Users sign in again once. There is no migration."
        },
        {
          "type": "text",
          "content": "Operators: the cookie is same-origin only — the UI and the API must be served from one origin (they are: the browser calls /api/... on the gateway that fronts both), and PLATFORM_FRONTEND_URL must name that origin so CORS and the OAuth callbacks agree. nginx passes Cookie/Set-Cookie through untouched on every shipped target and needs no proxy_cookie_path: the platform stamps the public path (/api/auth/refresh) even though nginx strips /api before proxying. Secure is set by default and every target terminates TLS in front of the gateway (docker and minikube on :8443, EC2 and EKS at the load balancer); browsers also accept Secure on http://localhost. Only a plain-http deployment on a non-localhost hostname needs AUTH_COOKIE_SECURE=false, and AUTH_REFRESH_COOKIE_PATH only if the UI is served under a different public prefix."
        }
      ]
    },
    {
      "id": "sessions-devices-and-machine-credentials",
      "title": "Sessions, devices and machine credentials",
      "blocks": [
        {
          "type": "note",
          "content": "Where these live. Everything that can sign in as you — password, passkeys, authenticator app, sessions and access keys — is on Dashboard → Security, in four tabs (Factors · Sessions · Access keys · Service accounts). It replaces Settings → Security, the \"API Tokens\" page (which carried a second, conflicting sessions list) and Settings → Service Accounts. The old addresses forward to the matching tab, so saved links and CLI docs still land; nothing of the old pages runs behind them."
        },
        {
          "type": "text",
          "content": "Dashboard → Security → Sessions lists the account's live sessions. Each refresh-session slot records a short client summary derived from the User-Agent (\"Chrome on macOS\" — no raw header, no versions) and the last IP it was used from. IPs are personal data: they live only as long as the slot, are dropped when the slot or the user is deleted, and are never geolocated."
        },
        {
          "type": "text",
          "content": "Sessions come in two kinds:"
        },
        {
          "type": "list",
          "items": [
            "Interactive — a signed-in device (password, social, SSO). Renewed by"
          ]
        },
        {
          "type": "text",
          "content": "POST /auth/refresh; at most 10 per user, the oldest dropped when an 11th signs in. Signing one out ends that device only."
        },
        {
          "type": "list",
          "items": [
            "Machine — a stored credential minted by POST /user/generate-token. Its"
          ]
        },
        {
          "type": "text",
          "content": "lifetime (expiresIn, 1–365 days) is the SLOT's: the response's refresh token is the thing to store, and it renews the short-lived access token through POST /auth/refresh (X-Pb-Client: cli, body { refreshToken }) until the slot's fixed end — which no renewal can move. Its access tokens never live longer than a person's (the per-tier access lifetime), so revoking the slot (Sessions → revoke) ends the credential on every service immediately (revoke:sid:<sid>). At most 10 per user, the least recently used dropped first, so a credential renewed daily is never evicted and abandoned ones are."
        },
        {
          "type": "text",
          "content": "> Not what stored credentials use any more. pipeline-manager infra > store-token, the AWS rotation Lambda and CI all hold > service-account keys now — a machine > session was still a person's credential, and that is the thing #12 / #N2 > removed. A machine session is what remains for a person who deliberately wants > a long-lived token of their own."
        },
        {
          "type": "text",
          "content": "Dashboard → Security → Access keys → Generate machine token mints one: the person picks its lifetime (1 day to 365 days — the API's ceiling) and, optionally, one capability scope (reporting:ingest, registry:push, scim), in which case the token carries none of their permissions. Token history beneath it (GET /user/tokens) lists every token issued to the account with its issue and expiry time and whether it is still active, expired, or revoked by a sign-out-everywhere."
        },
        {
          "type": "text",
          "content": "generate-token from a person's own session opens a new machine session holding the requested scope, leaving the caller's own login untouched. It is refused (403 SESSION_SLOT_REQUIRED) for anything that is not a person's session slot — an exchanged access key, a service account, an impersonation session — so revoking a key can never leave a longer-lived credential derived from it behind. Called with a machine token, it renews that session in place under the scope stored on the slot — a machine session can never open another one, and a scoped credential can never re-mint itself unscoped, under a different scope, or as a browser session. Two store-token runs from one login therefore produce two independent credentials with their own scopes."
        },
        {
          "type": "text",
          "content": "GET /user/sessions / DELETE /user/sessions/:id back the page. The session making the request is marked and cannot revoke itself (that is POST /auth/logout); revoking is step-up gated, and every revocation is audited as user.session.revoke. Revoking a machine session stops its renewal — the token it last minted keeps working until it expires, so use \"Sign out everywhere\" (a tokenVersion bump, which ends every session of both kinds and revokes the user's access keys) when a credential must die now."
        },
        {
          "type": "note",
          "content": "Operators: every stored machine credential is a service-account key — see Stored machine credentials (AWS) and Access Keys and Machine Credentials. Personal access credentials are keys as well. The secret never stores a refresh token, so consumers read password, which holds a pb_sa_… key."
        }
      ]
    },
    {
      "id": "see-also",
      "title": "See also",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Environment Variables → Authentication — every OAUTH_* and WEBAUTHN_* variable.",
            "Roles & Permissions — the org:idp/org:kms capabilities, sessions, and tokenVersion invalidation.",
            "Billing Add-on Bundles — feature entitlements, and why sso is a Team-and-above tier feature rather than an add-on.",
            "Audit Events — SSO/IdP config change actions, user.step-up, user.passkey., user.key., device.authorize.*.",
            "Access Keys and Machine Credentials — issuing personal keys and provisioning the three stored machine credentials."
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/authentication.md"
};
