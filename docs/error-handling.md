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
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
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
