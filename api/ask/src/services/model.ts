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
