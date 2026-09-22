---
layout: default
title: Error Handling
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Error Handling Convention

The error-to-HTTP convention for the codebase: **throw typed `AppError`s**.

## Throw typed `AppError`s (api-core)

Service/handler code should throw the **typed error classes** from
`@pipeline-builder/api-core` (`packages/api-core/src/errors/app-errors.ts`). Each
carries its own HTTP status and machine `code`, so a central layer translates it to
a response with no per-call mapping:

| Class | Status | `code` |
|-------|:------:|--------|
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ForbiddenError` | 403 | `INSUFFICIENT_PERMISSIONS` |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `ConflictError` | 409 | `CONFLICT` |
| `AppError` (base) | *explicit* | *explicit* | — for a one-off `(status, code, message)`. |

```ts
import { NotFoundError, ConflictError } from '@pipeline-builder/api-core';

const plan = await Plan.findById(id);
if (!plan) throw new NotFoundError('Plan not found');       // → 404 NOT_FOUND
if (existing) throw new ConflictError('Alias already taken'); // → 409 CONFLICT
```

Why: the status/code live **with the error**, not in a per-controller lookup table,
so a renamed message can't silently change a status, and the same error maps
identically everywhere it's thrown.

## Rules of thumb

- Throw a typed `AppError` subclass for any expected, user-facing failure.
- **Never** throw a bare `new Error('...')` for such a failure — it lands as a
  generic 500. Use a typed error (or `sendError` directly in a route).
- **Fail-soft background paths** (webhooks, crons, promotion grants) `try/catch` and
  log/metric rather than throw — a non-request path has no response to translate to.

## Plugin ecosystem codes

The plugin ecosystem's refusals carry a narrower `code` so a client can react
without parsing the message. A refusal that lists what failed puts it in the
response's `details` (the plugin service's `EcosystemError`, an `AppError` that
also carries `details`).

| `code` | Status | When |
|--------|:------:|------|
| `PLUGIN_VERSION_FROZEN` | 409 | The version is referenced by a publish request or already listed: it can't be re-uploaded, edited or deleted |
| `PLUGIN_DIGEST_MISMATCH` | 409 | The version's image digest isn't the one the request pinned; approval fails closed |
| `PUBLISHER_REQUIRED` | 409 | The org has no publisher profile yet |
| `PUBLISHER_HANDLE_RESERVED` | 409 | The handle (or listing name) is reserved; submit a `claim` request |
| `PUBLISH_GATE_FAILED` | 409 | A version request fails a submit gate; `details.gates` lists them |
| `VERIFIED_PLAN_REQUIRED` | 403 | A Verified application (or its approval) from an org whose plan lacks `verified_publisher` (Team or Enterprise); `details.checks` lists every eligibility check |
| `VERIFIED_DOMAIN_REQUIRED` | 409 | A Verified application from an org with no DNS-verified domain, or naming a domain the org hasn't verified; `details.checks` |
| `VERIFIED_OWNER_MFA_REQUIRED` | 409 | A Verified application from an org whose owner has no passkey or authenticator app; `details.checks` |
| `PUBLISHER_TERMS_REQUIRED` | 403 | The publisher hasn't accepted the current terms version |
| `PUBLISHER_ROOT_ORG_REQUIRED` | 403 | A team org tried to act as a publisher |
| `PUBLISHER_SUSPENDED` | 403 | The system org suspended the publisher |
| `PLUGIN_PUBLISHING_DISABLED` | 403 | `PLUGIN_PUBLISHING_ENABLED` is off for tenant orgs |
| `PLUGIN_REVIEWS_DISABLED` | 403 | `PLUGIN_REVIEWS_ENABLED` is off: reviews are read-only (writing, editing, votes, reports and replies are refused; moderation still works) |
| `REVIEW_SELF_PROMOTION` | 403 | A member of the publisher's own org (or a team under it) tried to review one of its listings, or vote on one of its reviews |
| `SEPARATION_OF_DUTIES` | 403 | An Ecosystem Manager tried to decide a request from their own org, their own upload, or give both approvals of a two-person decision |
| `SYSTEM_ORG_REQUIRED` | 403 | An ecosystem-governance route was called from an org other than the system org |
| `QUOTA_EXCEEDED` | 429 | With `details.quotaType: 'listings'`: at (or, after a downgrade, over) the plan's listings limit |
| `PLUGIN_NOT_INSTALLED` | 403 | A plugin reference, or lookup, needs an install the org doesn't have. `details.reason`: `not_installed`, `pending_approval`, `denied`, `official_explicit` (the policy turned off implicit Official installs) or `version_outside_install` (the requested version is outside the install's range) |
| `PLUGIN_BLOCKED_BY_POLICY` | 403 | The org's consumption policy refuses the listing or version. `details.reason`: `tier` (not in `allowedTiers`), `blocked_listing` (in `blockedListings`) or `advisory` (a published advisory at or above `blockOnAdvisory`) |
| `PLUGIN_UNAVAILABLE` | 409 | The listing or version can't be used. `details.reason`: `yanked` (a pin to a yanked listing version), `suspended` or `paused` (a paused listing takes no new installs) |
| `PLUGIN_NAME_LISTED` | 409 | An auto-created placeholder plugin can't take the name of a listed plugin; install the listing instead |
| `IMAGE_VERIFICATION_FAILED` | 409 | The image's signature doesn't verify, or, for a listing, its signed trust tier and publisher don't match the publisher's current tier and handle |

Pipeline create and update report the install codes per step in a `400`: every qualified plugin reference (one with `publisher`) that isn't installed, is blocked by policy or can't resolve is listed with its reason. See [Plugin Installing](plugin-installing.md#errors-you-may-see).
