// GENERATED FROM docs/error-handling.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 0c943fd8f2243729d7f76c9e3900233d07caf1a46f9cc65f40e5cae0610ad41e
// SPDX-License-Identifier: Apache-2.0
import { TriangleAlert } from 'lucide-react';
import type { HelpTopic } from '../types';

export const errorHandlingTopic: HelpTopic = {
  "icon": TriangleAlert,
  "id": "error-handling",
  "title": "Error Handling",
  "description": "The error-to-HTTP convention and the typed AppError catalog",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "The error-to-HTTP convention for the codebase: throw typed AppErrors."
        }
      ]
    },
    {
      "id": "throw-typed-apperrors-api-core",
      "title": "Throw typed AppErrors (api-core)",
      "blocks": [
        {
          "type": "text",
          "content": "Service/handler code should throw the typed error classes from @pipeline-builder/api-core (packages/api-core/src/errors/app-errors.ts). Each carries its own HTTP status and machine code, so a central layer translates it to a response with no per-call mapping:"
        },
        {
          "type": "table",
          "headers": [
            "Class",
            "Status",
            "code"
          ],
          "rows": [
            [
              "NotFoundError",
              "404",
              "NOT_FOUND"
            ],
            [
              "ForbiddenError",
              "403",
              "INSUFFICIENT_PERMISSIONS"
            ],
            [
              "ValidationError",
              "400",
              "VALIDATION_ERROR"
            ],
            [
              "ConflictError",
              "409",
              "CONFLICT"
            ],
            [
              "AppError (base)",
              "explicit",
              "explicit",
              "— for a one-off (status, code, message)."
            ]
          ]
        },
        {
          "type": "code",
          "content": "import { NotFoundError, ConflictError } from '@pipeline-builder/api-core';\n\nconst plan = await Plan.findById(id);\nif (!plan) throw new NotFoundError('Plan not found');       // → 404 NOT_FOUND\nif (existing) throw new ConflictError('Alias already taken'); // → 409 CONFLICT",
          "language": "ts"
        },
        {
          "type": "text",
          "content": "Why: the status/code live with the error, not in a per-controller lookup table, so a renamed message can't silently change a status, and the same error maps identically everywhere it's thrown."
        }
      ]
    },
    {
      "id": "rules-of-thumb",
      "title": "Rules of thumb",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Throw a typed AppError subclass for any expected, user-facing failure.",
            "Never throw a bare new Error('...') for such a failure — it lands as a"
          ]
        },
        {
          "type": "text",
          "content": "generic 500. Use a typed error (or sendError directly in a route)."
        },
        {
          "type": "list",
          "items": [
            "Fail-soft background paths (webhooks, crons, promotion grants) try/catch and"
          ]
        },
        {
          "type": "text",
          "content": "log/metric rather than throw — a non-request path has no response to translate to."
        }
      ]
    }
  ],
  "sourceDoc": "docs/error-handling.md"
};
