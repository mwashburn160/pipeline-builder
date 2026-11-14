// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt } from '@pipeline-builder/api-core';

/**
 * Per-model-call output cap for every generation the Ask service itself pays for
 * (how-to answers, each agent step, in-process template drafts). Bounds the $
 * cost one `aiCalls` slot can represent; a user-supplied prompt can't request an
 * unbounded answer.
 */
export const ASK_MAX_OUTPUT_TOKENS = envInt('ASK_MAX_OUTPUT_TOKENS', 2048, { min: 64 });

/**
 * Sampling temperature for the assistant's own calls. Low: answers are grounded in
 * the docs and drafts are structured config, neither of which wants creativity.
 * Dropped automatically for models that refuse a temperature (`aiCallSettings`).
 */
export const ASK_TEMPERATURE = 0.2;

/**
 * How many CHARGED generations one agent turn may start (default 2). Every
 * generating tool — `propose_pipeline`, `propose_pipeline_from_repo`,
 * `propose_plugin`, `propose_plugin_from_repo`, `propose_template` — spends its
 * OWN `aiCalls` slot on top of the turn's, and the model may call several in one
 * step, so the step bound alone does not cap a turn's cost: a prompt-injected
 * document or repository could otherwise ask for a dozen drafts. Past the cap a
 * generating tool declines instead of generating. A claim is spent when the tool
 * starts, whether or not its generation then succeeds.
 */
export const ASK_MAX_TURN_GENERATIONS = envInt('ASK_MAX_TURN_GENERATIONS', 2, { min: 1, max: 10 });
