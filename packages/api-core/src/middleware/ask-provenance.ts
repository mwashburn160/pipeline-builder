// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `proposable` — the gate on the one request header a client may use to
 * influence an audit event.
 *
 * The Ask panel's confirm path commits a drafted change through the SAME route
 * the dashboard's own button calls, with the user's own session. Design rule 6
 * says the resulting audit event must record that an AI drafted it, so an
 * incident review can tell "the admin changed this" from "an AI drafted it and
 * the admin clicked Apply". The browser says so with `X-PB-Proposed-By`.
 *
 * That is a client writing into the hash-chained audit trail, so the channel is
 * made as narrow as a channel can be: ONE header, ONE accepted value (the
 * shared `ASK_AGENT_PROPOSER` constant), writing ONE additive key. There is no
 * free text and no object to merge — `withProposalProvenance` re-derives the
 * fragment from the constant rather than copying anything off the request, so
 * the worst a caller can do is assert the one thing the header exists to
 * assert.
 *
 * REJECT, NOT IGNORE. A value other than the constant fails the request with a
 * 400 before the handler runs, because:
 *
 *  - Silently dropping it reproduces the exact bug this work exists to fix. The
 *    reason provenance was never sent before is that the update schemas are
 *    non-strict `z.object`s that STRIP unknown keys, so a client could send the
 *    field and have it vanish. A header that is quietly ignored is the same
 *    trap one layer up, and the next reader would have to prove by experiment
 *    whether it lands.
 *  - No legitimate client sends any other value, so a rejection can break
 *    nothing that works today. An unexpected value is either a client bug —
 *    which should fail loudly, at the write, not leave a trail that is silently
 *    missing its marker — or someone probing what the audit trail will accept,
 *    which should be counted (`ask_provenance_refused_total`) rather than
 *    absorbed.
 *  - Failing BEFORE the mutation means a refusal never leaves a written change
 *    whose provenance was thrown away. The alternative — write, then drop the
 *    marker — is the one outcome that makes the trail actively misleading.
 *
 * Belt and braces: {@link readProposerClaim} honours nothing but the constant,
 * so even a route that forgot this gate cannot store a forged proposer. The
 * gate turns "ignored" into "refused"; it is not what makes forgery harmless.
 */

import type { Request, Response, NextFunction } from 'express';
import { ASK_PROPOSED_BY_HEADER, readProposerClaim } from '../types/ask-proposals.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { sendBadRequest } from '../utils/response.js';

/** Counter incremented when a request claims a proposer that is not the agent. */
export const ASK_PROVENANCE_REFUSED_COUNTER = 'ask_provenance_refused_total';

/**
 * Express middleware for a route an Ask proposal may commit to: accept the
 * agent provenance marker, refuse any other proposer with a 400.
 *
 * Place it in the chain beside `audited(...)`, before the handler:
 * `router.put('/:id', audited('pipeline.update'), proposable, withRoute(h))`.
 * The handler then records with `withProposalProvenance(req.headers, {...})`.
 */
export function proposable(req: Request, res: Response, next: NextFunction): void {
  if (readProposerClaim(req.headers) === 'foreign') {
    emitCounter(ASK_PROVENANCE_REFUSED_COUNTER, { method: req.method });
    // The rejected value is never echoed back — it is attacker-controlled text,
    // and the rule is short enough to state outright.
    sendBadRequest(res, `Unrecognised ${ASK_PROPOSED_BY_HEADER} header: the only proposer this route accepts is the Ask agent.`);
    return;
  }
  next();
}
