// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/**
 * Request body shared by the read-only how-to routes (`/ask`, `/ask/stream`) and the
 * tool-calling agent (`/ask/agent/stream`). `history` is the client-held transcript
 * (v1 has no server-side conversation store); it is bounded to keep the prompt sane.
 */
export const AskBodySchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(4000),
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(20)
    .optional(),
});

export type AskBody = z.infer<typeof AskBodySchema>;
