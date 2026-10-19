// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/**
 * Request body shared by the read-only how-to routes (`/ask`, `/ask/stream`) and the
 * tool-calling agent (`/ask/agent/stream`). `history` is the client-held transcript
 * (v1 has no server-side conversation store); it is bounded to keep the prompt sane.
 */
export const AskBodySchema = z.object({
  // Sized to carry a full generation prompt (the create dialogs allow 5000 chars)
  // plus the short instruction the dialogs wrap it in when routed via the agent.
  query: z.string().trim().min(1, 'query is required').max(6000),
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  /**
   * Private-repo access token for `propose_pipeline_from_repo`. Handed to that
   * tool out-of-band (like provider/model) — it is never placed in the model's
   * context, so the model can neither see nor echo it.
   */
  repoToken: z.string().min(1).max(500).optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(20)
    .optional(),
});

/**
 * `POST /ask/feedback` — a reader rating an answer, or a help search that found
 * nothing.
 *
 * Carries NO free text, by construction rather than by convention: there is no
 * field a question or a search term could travel in. `sources` are doc ids the
 * answer cited (`authentication.md`), which name the thing to fix and are not
 * user input.
 */
export const AskFeedbackSchema = z.object({
  kind: z.enum(['answer', 'help-search-miss']),
  /** Required for `answer`; meaningless for a search miss. */
  rating: z.enum(['up', 'down']).optional(),
  /** Doc ids the rated answer cited. Bounded — an answer cites a handful. */
  sources: z.array(z.string().max(200)).max(20).optional(),
}).refine((v) => v.kind !== 'answer' || v.rating !== undefined, {
  message: 'rating is required when kind is "answer"',
  path: ['rating'],
});
