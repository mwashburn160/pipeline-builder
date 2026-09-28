---
layout: default
title: Error Handling
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Error Handling

How a failure inside the codebase becomes an HTTP response: **throw a typed `AppError`**.

## Highlights

- **One rule.** Throw a typed error class from `@pipeline-builder/api-core`. A central layer turns it into a response — no per-controller mapping table.
- **Status and code travel with the error**, so renaming a message can never silently change a status, and the same failure maps identically everywhere it is thrown.
- **A bare `new Error()` is a bug.** It lands as a generic 500.
- **Background paths are the exception.** Webhooks, crons and promotion grants catch and log instead of throwing — there is no response to translate to.
- **The plugin ecosystem adds narrow codes** so a client can react without parsing prose, with the specifics in `details`.

## Overview

Every expected, user-facing failure in service and handler code is expressed as a thrown error object that already knows its own HTTP status and machine-readable `code`. A single translation layer converts it to the wire format.

This is for anyone writing service or route code in this repo. If you are instead *consuming* the API and want to know what a given code means, the [plugin ecosystem codes](#plugin-ecosystem-codes) table below and [Plugin Installing](plugin-installing.md#errors-you-may-see) are the reference you want.

## How it works

1. **Code throws a typed error.** `throw new NotFoundError('Plan not found')` — not a status, not a response object, just the error.
2. **The error carries its own contract.** Each class in `packages/api-core/src/errors/app-errors.ts` fixes an HTTP status and a stable `code` string.
3. **A central layer translates it.** The status and `code` come off the error; the message becomes the body. No controller needs a lookup table.
4. **The client reacts to `code`, not to the message.** Messages are for humans and may be reworded; `code` is the stable contract.

### The typed classes

| Class | Status | `code` |
|-------|:------:|--------|
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ForbiddenError` | 403 | `INSUFFICIENT_PERMISSIONS` |
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `ConflictError` | 409 | `CONFLICT` |
| `AppError` (base) | *explicit* | *explicit* |

`AppError` is the escape hatch for a one-off `(status, code, message)`.

```ts
import { NotFoundError, ConflictError } from '@pipeline-builder/api-core';

const plan = await Plan.findById(id);
if (!plan) throw new NotFoundError('Plan not found');         // → 404 NOT_FOUND
if (existing) throw new ConflictError('Alias already taken');  // → 409 CONFLICT
```

## Applying the convention

1. **Pick the closest typed class** for the failure you are reporting. Reach for `AppError` directly only when no subclass fits.
2. **Throw it, don't return it.** The translation layer only sees thrown errors.
3. **Never throw a bare `new Error('...')`** for a user-facing failure — it becomes an opaque 500. If you need to write the response yourself, call `sendError` in the route instead.
4. **Wrap fail-soft background paths in `try/catch`** and log or emit a metric. A webhook handler, cron or promotion grant has no request to answer, so a throw there just loses the failure.
5. **Attach machine-readable specifics to `details`** when the caller needs to act on them (which gates failed, which findings blocked a build) rather than burying them in the message.

## Plugin ecosystem codes

The plugin ecosystem's refusals carry a narrower `code` so a client can react without parsing the message. A refusal that lists what failed puts it in the response's `details` — that is the plugin service's `EcosystemError`, an `AppError` that also carries `details`.

### Publisher and publishing

| `code` | Status | When |
|--------|:------:|------|
| `PLUGIN_VERSION_FROZEN` | 409 | The version is referenced by a publish request or already listed: it can't be re-uploaded, edited or deleted |
| `PLUGIN_DIGEST_MISMATCH` | 409 | The version's image digest isn't the one the request pinned; approval fails closed |
| `PUBLISHER_REQUIRED` | 409 | The org has no publisher profile yet |
| `PUBLISHER_HANDLE_RESERVED` | 409 | The handle (or listing name) is reserved; submit a `claim` request |
| `PUBLISH_GATE_FAILED` | 409 | A version request fails a submit gate; `details.gates` lists them |
| `PUBLISHER_TERMS_REQUIRED` | 403 | The publisher hasn't accepted the current terms version |
| `PUBLISHER_ROOT_ORG_REQUIRED` | 403 | A team org tried to act as a publisher |
| `PUBLISHER_SUSPENDED` | 403 | The system org suspended the publisher |
| `PLUGIN_PUBLISHING_DISABLED` | 403 | `PLUGIN_PUBLISHING_ENABLED` is off for tenant orgs |
| `PLUGIN_NAME_LISTED` | 409 | An auto-created placeholder plugin can't take the name of a listed plugin; install the listing instead |

### Verified publisher eligibility

Each of these carries `details.checks` listing every eligibility check.

| `code` | Status | When |
|--------|:------:|------|
| `VERIFIED_PLAN_REQUIRED` | 403 | A Verified application (or its approval) from an org whose plan lacks `verified_publisher` (Team or Enterprise) |
| `VERIFIED_DOMAIN_REQUIRED` | 409 | A Verified application from an org with no DNS-verified domain, or naming a domain the org hasn't verified |
| `VERIFIED_OWNER_MFA_REQUIRED` | 409 | A Verified application from an org whose owner has no passkey or authenticator app |

### Governance and moderation

| `code` | Status | When |
|--------|:------:|------|
| `PLUGIN_REVIEWS_DISABLED` | 403 | `PLUGIN_REVIEWS_ENABLED` is off: reviews are read-only (writing, editing, votes, reports and replies are refused; moderation still works) |
| `REVIEW_SELF_PROMOTION` | 403 | A member of the publisher's own org (or a team under it) tried to review one of its listings, or vote on one of its reviews |
| `SEPARATION_OF_DUTIES` | 403 | An Ecosystem Manager tried to decide a request from their own org, their own upload, or give both approvals of a two-person decision |
| `SYSTEM_ORG_REQUIRED` | 403 | An ecosystem-governance route was called from an org other than the system org |

### Consuming a listing

| `code` | Status | When |
|--------|:------:|------|
| `QUOTA_EXCEEDED` | 429 | With `details.quotaType: 'listings'`: at (or, after a downgrade, over) the plan's listings limit |
| `PLUGIN_NOT_INSTALLED` | 403 | A plugin reference, or lookup, needs an install the org doesn't have. `details.reason`: `not_installed`, `pending_approval`, `denied`, `official_explicit` (the policy turned off implicit Official installs) or `version_outside_install` (the requested version is outside the install's range) |
| `PLUGIN_BLOCKED_BY_POLICY` | 403 | The org's consumption policy refuses the listing or version. `details.reason`: `tier` (not in `allowedTiers`), `blocked_listing` (in `blockedListings`) or `advisory` (a published advisory at or above `blockOnAdvisory`) |
| `PLUGIN_UNAVAILABLE` | 409 | The listing or version can't be used. `details.reason`: `yanked` (a pin to a yanked listing version), `suspended` or `paused` (a paused listing takes no new installs) |
| `IMAGE_VERIFICATION_FAILED` | 409 | The image's signature doesn't verify, or, for a listing, its signed trust tier and publisher don't match the publisher's current tier and handle |

### Vulnerability gates

| `code` | Status | When |
|--------|:------:|------|
| `PLUGIN_VERSION_VULN_BLOCKED` | 409 | With `PLUGIN_BLOCK_ON_NEW_CRITICAL` on, a lookup pinned exactly (version or id) to a version the nightly rescan flagged (fixable Criticals over `PLUGIN_VULN_MAX_CRITICAL`) — or a range whose every satisfying version is flagged. `details`: `reason: 'vuln_flagged'`, `version`, `critical`, `high`, `findings[]` (id, package, installed version, `fixedIn`), `fixedVersions` (listings). The message names the CVEs and fixes; the CLI prints it as-is |
| `IMAGE_SCAN_UNAVAILABLE` | 422 | A **build** outcome, not a request answer: the built image could not be vulnerability-scanned after every retry, so nothing was saved (`PLUGIN_ALLOW_UNSCANNED` persists it unscanned instead). Carried as `code` on the build stream's `ERROR` event and as `details.errorCode` on `plugin.build.failed` |
| `PLUGIN_VULN_GATE` | 422 | A **build** outcome: the image has more fixable Critical findings than `PLUGIN_VULN_MAX_CRITICAL`. The message lists the top CVEs with their fixed versions; the build stream's `ERROR` event carries `code` and `details` (`critical`, `high`, `maxCritical`, `findings[]`) |

### How pipeline create reports install failures

Pipeline create and update report the install codes **per step** in a single `400`: every qualified plugin reference (one with `publisher`) that isn't installed, is blocked by policy or can't resolve is listed with its reason. See [Plugin Installing](plugin-installing.md#errors-you-may-see).

## Related

- [Plugin Installing](plugin-installing.md) — the install and policy model these codes enforce
- [API Reference](api-reference.md) — the endpoints that return them
- [Plugin Publishing](plugin-publishing.md) — the publisher and Verified flows
